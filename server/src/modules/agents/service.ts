import { randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';
import { type Agent, type AgentStatus, Prisma } from '../../generated/prisma/client.js';
import { imageExists, inspectContainer, removeContainer, removeVolume } from '../../lib/docker.js';
import { config } from '../../config.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { toContainerPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { moveAgentTask, taskForAgent } from '../boards/service.js';
import { getResourceUsage } from '../system/service.js';
import type { UsageTotals } from '../usage/calc.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { openPullRequest } from './pull-requests.js';
import { authenticatedPushUrl, closingReference, parseRemote, remoteHostname, type RemoteInfo } from './remote.js';
import { agentVolumeName, startAgentContainer, stopAgentContainer } from './runtime.js';
import { commitAndPush, currentBranch, prepareWorkdir, removeWorkdir, workdirDiff, workdirHostPath } from './workdir.js';

export const AGENT_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export interface LaunchAgentInput {
  projectId: string;
  prompt: string;
  title?: string;
  model: AgentModel;
  baseBranch?: string;
  /** Board item the agent will solve; it is moved across the board columns as the agent progresses. */
  taskItemId?: string;
  /** The user already confirmed launching while Docker usage is high. */
  confirmHighUsage?: boolean;
  /** Sentinel launching the agent (not accepted from the public API). */
  sentinelId?: string;
}

/** Separates the task from the board guidelines in the first message (the PR body keeps only the task). */
const BOARD_RULES_SEPARATOR = '\n\n---\nRegras do quadro de tarefas (README):\n';
const MAX_BOARD_RULES = 6_000;

/** Agents needing the user come first, then the most recently active. */
const STATUS_PRIORITY: Partial<Record<AgentStatus, number>> = { WAITING_INPUT: 0, READY_FOR_REVIEW: 1 };

const agentInclude = {
  project: { select: { name: true } },
  workspace: { select: { name: true } },
  sentinel: { select: { name: true } },
} satisfies Prisma.AgentInclude;

type AgentWithNames = Prisma.AgentGetPayload<{ include: typeof agentInclude }>;

export async function addEvent(agentId: string, type: string, data: Prisma.InputJsonValue = {}) {
  await prisma.agentEvent.create({ data: { agentId, type, data } });
}

function errorMessage(error: unknown) {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message.slice(0, 500) : 'Erro desconhecido.';
}

export async function markFailed(agentId: string, error: unknown) {
  const message = errorMessage(error);
  await prisma.agent.update({
    where: { id: agentId },
    data: { status: 'FAILED', errorMessage: message, lastActivityAt: new Date() },
  });
  await addEvent(agentId, 'error', { message });
}

// ---------------------------------------------------------------- queries

export async function listAgents(filter: { workspaceId?: string }) {
  const agents = await prisma.agent.findMany({
    where: filter.workspaceId ? { workspaceId: filter.workspaceId } : {},
    include: agentInclude,
    orderBy: { lastActivityAt: 'desc' },
    take: 500,
  });
  return agents
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9))
    .map(toResponse);
}

export async function getAgent(id: string) {
  const agent = await prisma.agent.findUnique({ where: { id }, include: agentInclude });
  if (!agent) throw notFound('Agente não encontrado.');
  return toResponse(agent);
}

export async function listAgentEvents(id: string, afterId: number) {
  await findOrThrow(id);
  return prisma.agentEvent.findMany({
    where: { agentId: id, id: { gt: afterId } },
    orderBy: { id: 'asc' },
    take: 500,
    select: { id: true, type: true, data: true, createdAt: true },
  });
}

export async function getAgentDiff(id: string) {
  const agent = await findOrThrow(id);
  if (!agent.baseCommit) throw new HttpError(409, 'A cópia do projeto ainda está sendo preparada.');
  return workdirDiff(agent.workdir, agent.baseCommit);
}

// ---------------------------------------------------------------- launch

function slugify(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

export async function launchAgent(input: LaunchAgentInput) {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, include: { workspace: true } });
  if (!project || project.missingAt) throw notFound('Projeto não encontrado.');
  if (!project.isGitRepo) throw new HttpError(422, 'Agentes só podem ser lançados em projetos com git.');

  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId: project.workspaceId } });
  if (!settings?.agentAccountId) {
    throw new HttpError(422, 'Configure a conta de agente (Claude) do workspace antes de lançar agentes.');
  }
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto não tem um remote "origin" válido para enviar o PR/MR.');
  await findGitAccount(project.workspaceId, remote);
  if (!(await imageExists(config.agentRunnerImage))) {
    throw new HttpError(503, 'Imagem do agent-runner não encontrada. Rode: docker compose --profile tools build agent-runner');
  }
  if (!input.confirmHighUsage) {
    const usage = await getResourceUsage().catch(() => null);
    if (usage && usage.launchWarnings.length > 0) {
      throw new HttpError(409, 'O Studio está com consumo alto no Docker.', { code: 'HIGH_USAGE', warnings: usage.launchWarnings });
    }
  }

  const projectDir = toContainerPath(project.workspace.name, project.name);
  const baseBranch = input.baseBranch?.trim() || (await currentBranch(projectDir));
  if (!baseBranch) {
    throw new HttpError(422, 'O projeto está sem branch atual (HEAD destacado). Informe a branch base.');
  }

  const task = input.taskItemId ? await taskForAgent(project.workspaceId, input.taskItemId) : null;
  const prompt = input.prompt.trim();
  const message = task?.readme ? `${prompt}${BOARD_RULES_SEPARATOR}${task.readme.slice(0, MAX_BOARD_RULES)}` : prompt;
  const title = input.title?.trim() || (prompt.split('\n')[0] ?? prompt).slice(0, 80);
  const shortId = randomBytes(4).toString('hex');
  const slug = slugify(title);

  const agent = await prisma.agent.create({
    data: {
      workspaceId: project.workspaceId,
      projectId: project.id,
      title,
      model: input.model,
      baseBranch,
      branch: `agent/${slug ? `${slug}-` : ''}${shortId}`,
      workdir: `${project.workspace.name}/${project.name}-${shortId}`,
      ...(task && { taskItemId: task.item.id, taskRef: task.taskRef, taskUrl: task.item.url }),
      ...(input.sentinelId && { sentinelId: input.sentinelId }),
    },
    include: agentInclude,
  });
  await addEvent(agent.id, 'user_message', { text: message });
  await prisma.agentInbox.create({ data: { agentId: agent.id, kind: 'MESSAGE', payload: { text: message } } });

  void prepareAndStart(agent.id, projectDir, project.gitRemoteUrl);
  if (task) void reportTaskMove(agent, 'inProgress', true);
  return toResponse(agent);
}

async function reportTaskMove(agent: Agent, role: 'inProgress' | 'review', assignSelf = false) {
  const message = await moveAgentTask(agent, role, { assignSelf });
  if (message) await addEvent(agent.id, 'status', { message });
}

async function prepareAndStart(agentId: string, projectDir: string, remoteUrl: string | null) {
  try {
    const agent = await findOrThrow(agentId);
    const { baseCommit } = await prepareWorkdir({
      projectDir,
      workdir: agent.workdir,
      baseBranch: agent.baseBranch,
      branch: agent.branch,
      remoteUrl,
    });
    await prisma.agent.update({ where: { id: agentId }, data: { baseCommit } });
    await addEvent(agentId, 'status', {
      message: `Cópia isolada criada em ${workdirHostPath(agent.workdir)} na branch ${agent.branch}.`,
    });
    await ensureContainer(agentId);
  } catch (error) {
    await markFailed(agentId, error);
  }
}

// ---------------------------------------------------------------- container

const starting = new Set<string>();

/** Makes sure a runner container is up for the agent, resuming its Claude session when there is one. */
export async function ensureContainer(agentId: string) {
  if (starting.has(agentId)) return;
  starting.add(agentId);
  try {
    const agent = await findOrThrow(agentId);
    if (!agent.baseCommit || agent.status === 'CANCELLED' || agent.status === 'FINALIZING') return;

    if (agent.containerId) {
      const state = await inspectContainer(agent.containerId);
      if (state?.running) return;
      await removeContainer(agent.containerId);
    }

    const settings = await prisma.workspaceSettings.findUnique({
      where: { workspaceId: agent.workspaceId },
      include: { agentAccount: true },
    });
    if (!settings?.agentAccount) {
      throw new HttpError(422, 'O workspace está sem conta de agente (Claude) configurada.');
    }

    const { containerId, secretHash } = await startAgentContainer({
      agent,
      claudeToken: secrets.decrypt(settings.agentAccount.tokenEncrypted),
      skillIds: settings.enabledSkillIds,
    });
    await prisma.agent.update({ where: { id: agentId }, data: { containerId, secretHash } });
  } finally {
    starting.delete(agentId);
  }
}

function wake(agentId: string) {
  void ensureContainer(agentId).catch((error: unknown) => markFailed(agentId, error));
}

// ---------------------------------------------------------------- interaction

export async function sendMessage(id: string, text: string) {
  const agent = await findOrThrow(id);
  if (agent.status === 'CANCELLED' || agent.status === 'FINALIZING') {
    throw new HttpError(409, 'Não é possível enviar mensagens para este agente agora.');
  }

  await prisma.agentInbox.create({ data: { agentId: id, kind: 'MESSAGE', payload: { text } } });
  await addEvent(id, 'user_message', { text });
  await prisma.agent.update({
    where: { id },
    data: {
      status: agent.status === 'PREPARING' ? 'PREPARING' : 'RUNNING',
      errorMessage: null,
      finishedAt: null,
      lastActivityAt: new Date(),
    },
  });
  wake(id);
  return getAgent(id);
}

export async function answerQuestion(id: string, answers: Record<string, string>) {
  const agent = await findOrThrow(id);
  if (agent.status !== 'WAITING_INPUT' || !agent.pendingQuestion) {
    throw new HttpError(409, 'O agente não está aguardando resposta.');
  }

  await prisma.agentInbox.create({ data: { agentId: id, kind: 'ANSWER', payload: { answers } } });
  await addEvent(id, 'answer', { answers });
  await prisma.agent.update({
    where: { id },
    data: { status: 'RUNNING', pendingQuestion: Prisma.DbNull, lastActivityAt: new Date() },
  });
  wake(id);
  return getAgent(id);
}

export async function cancelAgent(id: string) {
  const agent = await findOrThrow(id);
  if (agent.status === 'FINALIZING') throw new HttpError(409, 'Aguarde o envio das alterações terminar.');

  if (agent.containerId) await stopAgentContainer(agent.containerId);
  await prisma.agent.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      containerId: null,
      secretHash: null,
      pendingQuestion: Prisma.DbNull,
      finishedAt: new Date(),
      lastActivityAt: new Date(),
    },
  });
  await addEvent(id, 'status', { message: 'Agente cancelado.' });
  return getAgent(id);
}

/** Removes the agent, its container, session volume and isolated clone. */
export async function deleteAgent(id: string) {
  const agent = await findOrThrow(id);
  if (agent.status === 'FINALIZING') throw new HttpError(409, 'Aguarde o envio das alterações terminar.');

  if (agent.containerId) await stopAgentContainer(agent.containerId);
  await removeVolume(agentVolumeName(id));
  await removeWorkdir(agent.workdir);
  await prisma.agent.delete({ where: { id } });
}

// ---------------------------------------------------------------- finalize (commit + push + PR/MR)

export async function finalizeAgent(id: string) {
  const agent = await findOrThrow(id);
  if (agent.status !== 'READY_FOR_REVIEW') {
    throw new HttpError(409, 'Só é possível concluir um agente pronto para revisão.');
  }

  await prisma.agent.update({ where: { id }, data: { status: 'FINALIZING', errorMessage: null } });
  await addEvent(id, 'status', { message: 'Enviando alterações...' });
  void finalizeInBackground(id);
  return getAgent(id);
}

async function finalizeInBackground(id: string) {
  try {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id }, include: { project: true } });
    if (agent.containerId) {
      await stopAgentContainer(agent.containerId);
      await prisma.agent.update({ where: { id }, data: { containerId: null, secretHash: null } });
    }

    const remote = agent.project.gitRemoteUrl ? parseRemote(agent.project.gitRemoteUrl) : null;
    if (!remote || !agent.baseCommit) throw new HttpError(422, 'O projeto não tem remote para enviar.');
    const account = await findGitAccount(agent.workspaceId, remote);
    const token = secrets.decrypt(account.tokenEncrypted);
    const provider = account.provider as 'GITHUB' | 'GITLAB';

    const firstMessage = await prisma.agentEvent.findFirst({
      where: { agentId: id, type: 'user_message' },
      orderBy: { id: 'asc' },
    });
    const firstText = (firstMessage?.data as { text?: string } | null)?.text ?? agent.title;
    const task = firstText.split(BOARD_RULES_SEPARATOR)[0]!;
    const closes = closingReference(agent.taskRef, remote.path);
    const body = `${task}${closes ? `\n\n${closes}` : ''}\n\n---\nGerado pelo Agents Manager Studio.`;

    await commitAndPush({
      workdir: agent.workdir,
      baseCommit: agent.baseCommit,
      branch: agent.branch,
      message: { title: agent.title, body },
      author: {
        name: account.authorName || account.username,
        email: account.authorEmail || defaultAuthorEmail(provider, account.username, remoteHostname(remote)),
      },
      pushUrl: authenticatedPushUrl(remote, provider, token),
      token,
    });
    await addEvent(id, 'status', { message: `Branch ${agent.branch} enviada.` });

    const prUrl =
      agent.prUrl ??
      (await openPullRequest({
        provider,
        remote,
        token,
        branch: agent.branch,
        baseBranch: agent.baseBranch,
        title: agent.title,
        body,
      }));

    await prisma.agent.update({
      where: { id },
      data: { status: 'COMPLETED', prUrl, finishedAt: new Date(), lastActivityAt: new Date() },
    });
    await addEvent(id, 'completed', { prUrl });
    await reportTaskMove(agent, 'review');
  } catch (error) {
    // Back to review so the user can fix the cause (e.g. a token) and try again.
    const message = errorMessage(error);
    await prisma.agent.update({
      where: { id },
      data: { status: 'READY_FOR_REVIEW', errorMessage: message, lastActivityAt: new Date() },
    });
    await addEvent(id, 'error', { message });
  }
}

function defaultAuthorEmail(provider: 'GITHUB' | 'GITLAB', username: string, host: string) {
  return provider === 'GITHUB' ? `${username}@users.noreply.github.com` : `${username}@noreply.${host}`;
}

// ---------------------------------------------------------------- helpers

async function findOrThrow(id: string) {
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) throw notFound('Agente não encontrado.');
  return agent;
}

/** The workspace account whose host matches the project remote. */
function findGitAccount(workspaceId: string, remote: RemoteInfo) {
  return findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
}

/** Totals of the agent across models; cost is an estimate at API list prices. */
function usageOf(agent: Agent) {
  const models = Object.values((agent.usageTotals ?? {}) as unknown as UsageTotals);
  const sum = (key: keyof UsageTotals[string]) => models.reduce((total, model) => total + (model[key] ?? 0), 0);
  return {
    costUsd: agent.costUsd,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheCreationTokens: sum('cacheCreationInputTokens'),
  };
}

function toResponse(agent: Agent & Partial<Pick<AgentWithNames, 'project' | 'workspace' | 'sentinel'>>) {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    workspaceName: agent.workspace?.name ?? null,
    projectId: agent.projectId,
    projectName: agent.project?.name ?? null,
    title: agent.title,
    model: agent.model,
    status: agent.status,
    baseBranch: agent.baseBranch,
    branch: agent.branch,
    workdirHostPath: workdirHostPath(agent.workdir),
    isContainerRunning: agent.containerId !== null,
    pendingQuestion: agent.pendingQuestion,
    prUrl: agent.prUrl,
    taskItemId: agent.taskItemId,
    taskRef: agent.taskRef,
    taskUrl: agent.taskUrl,
    sentinelId: agent.sentinelId,
    sentinelName: agent.sentinel?.name ?? null,
    usage: usageOf(agent),
    errorMessage: agent.errorMessage,
    lastActivityAt: agent.lastActivityAt,
    createdAt: agent.createdAt,
    finishedAt: agent.finishedAt,
  };
}
