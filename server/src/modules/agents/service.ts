import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import { type Agent, type AgentProfile, type AgentStatus, Prisma } from '../../generated/prisma/client.js';
import { imageExists, inspectContainer, removeContainer, removeVolume } from '../../lib/docker.js';
import { config } from '../../config.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { toContainerPath, toHostPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { moveAgentTask, taskForAgent } from '../boards/service.js';
import { pullRequestNumber } from '../render/status.js';
import { getResourceUsage } from '../system/service.js';
import type { UsageTotals } from '../usage/calc.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { assertPushBranch, assertWorkBase } from './branch-guard.js';
import { isConflictMessage, mergeIntoBase, openPullRequest, pullRequestState } from './pull-requests.js';
import { authenticatedPushUrl, closingReference, defaultAuthorEmail, parseRemote, remoteHostname, type RemoteInfo } from './remote.js';
import { agentVolumeName, startAgentContainer, stopAgentContainer } from './runtime.js';
import { testServicesEnv } from './test-services.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { removeAgentVariables, writeAgentVariables } from '../agent-variables/service.js';
import {
  NO_CHANGES_MESSAGE,
  commitAndPush,
  currentBranch,
  checkoutRemoteBranch,
  isMergedInto,
  mergeRemoteBase,
  returnToAgent,
  prepareEmptyWorkdir,
  prepareWorkdir,
  removeWorkdir,
  updateToRemoteBase,
  workdirDiff,
  workdirHostPath,
  workdirPath,
} from './workdir.js';

export const AGENT_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export interface LaunchAgentInput {
  /** Repository the agent works on; omitted for agents without a repository (or the profile's only project). */
  projectId?: string | null;
  /** Workspace agent (profile) to run: brings its instructions, model, tools and output. */
  profileId?: string;
  prompt: string;
  title?: string;
  /** Defaults to the profile model, then Sonnet. */
  model?: AgentModel;
  baseBranch?: string;
  /** Continues another agent's work: clones its copy on its branch (workflow handoffs). */
  sourceAgentId?: string;
  /** Overrides the profile: conclude without waiting for the user. */
  autoConclude?: boolean;
  autoMerge?: boolean;
  /** Starts on an open PR/MR made outside the Studio (its branch, merging into its base) instead of a new branch. */
  pullRequest?: { url: string; branch: string; baseBranch: string };
  /** Board item the agent will solve; it is moved across the board columns as the agent progresses. */
  taskItemId?: string;
  /** The user already confirmed launching while Docker usage is high. */
  confirmHighUsage?: boolean;
  /** Workflow run launching the agent (not accepted from the public API). */
  workflowRunId?: string;
  /** Órbi conversation in this workspace (not accepted from the public launch API). */
  assistantWorkspaceId?: string;
}

/** Marks agents without a repository (their work folder is ready but has no base commit). */
const NO_REPOSITORY = 'none';

/** Separates the task from the board guidelines in the first message (the PR body keeps only the task). */
const BOARD_RULES_SEPARATOR = '\n\n---\nRegras do quadro de tarefas (README):\n';
const MAX_BOARD_RULES = 6_000;

/** Agents needing the user come first, then the most recently active. */
const STATUS_PRIORITY: Partial<Record<AgentStatus, number>> = { WAITING_INPUT: 0, READY_FOR_REVIEW: 1 };

const agentInclude = {
  project: { select: { name: true } },
  workspace: { select: { name: true } },
  workflowRun: { select: { workflow: { select: { name: true } } } },
  profile: { select: { name: true } },
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

/** Executions of the user's agents; without a workspace, only those of the workspaces the active view profile shows. */
export async function listAgents(ownerId: string, filter: { workspaceId?: string; profileId?: string; unassigned?: boolean }) {
  const agents = await prisma.agent.findMany({
    where: {
      // Órbi conversations are not executions: they live in the assistant panel.
      kind: 'TASK',
      workspace: { ownerId, ...(!filter.workspaceId && (await visibleWorkspaceFilter(ownerId))) },
      ...(filter.workspaceId && { workspaceId: filter.workspaceId }),
      ...(filter.profileId && { profileId: filter.profileId }),
      ...(filter.unassigned && { profileId: null }),
    },
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
  if (agent.baseCommit === NO_REPOSITORY) throw new HttpError(409, 'Este agente não trabalha em um repositório.');
  if (!agent.baseCommit) throw new HttpError(409, 'A cópia do projeto ainda está sendo preparada.');
  return workdirDiff(agent.workdir, agent.baseCommit);
}

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** An image or a sound from the agent's copy, by path relative to it (only media, never outside the copy). */
export async function agentMedia(id: string, relativePath: string) {
  const agent = await findOrThrow(id);
  const root = workdirPath(agent.workdir);
  const file = path.posix.resolve(root, decodeURIComponent(relativePath ?? ''));
  const contentType = MEDIA_TYPES[path.posix.extname(file).toLowerCase()];
  if (!contentType || !file.startsWith(`${root}/`)) throw new HttpError(404, 'Arquivo não encontrado.');
  const content = await readFile(file).catch(() => null);
  if (!content) throw new HttpError(404, 'Arquivo não encontrado (a cópia do agente pode já ter sido removida).');
  return { contentType, content };
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

/** Resolves the project of a launch from the input and the profile's allowed projects (null = no repository). */
async function resolveProject(input: LaunchAgentInput, profile: AgentProfile | null) {
  let projectId = input.projectId ?? null;
  if (!projectId && profile?.projectIds.length === 1) projectId = profile.projectIds[0]!;
  if (!projectId) {
    if (profile?.anyProject) throw new HttpError(422, `Escolha o projeto em que o agente "${profile.name}" vai trabalhar.`);
    if (profile && profile.projectIds.length > 1) throw new HttpError(422, `Escolha um dos projetos do agente "${profile.name}".`);
    if (!profile) throw new HttpError(422, 'Escolha o projeto do agente.');
    return null;
  }
  if (profile && !profile.anyProject && profile.projectIds.length > 0 && !profile.projectIds.includes(projectId)) {
    throw new HttpError(422, `O agente "${profile.name}" não trabalha neste projeto.`);
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { workspace: true } });
  if (!project || project.missingAt) throw notFound('Projeto não encontrado.');
  if (!project.isGitRepo) throw new HttpError(422, 'Agentes só podem ser lançados em projetos com git.');
  if (profile && project.workspaceId !== profile.workspaceId) throw new HttpError(422, 'O projeto é de outro workspace.');
  return project;
}

export async function launchAgent(input: LaunchAgentInput) {
  const isAssistant = Boolean(input.assistantWorkspaceId);
  const profile = input.profileId ? await prisma.agentProfile.findUnique({ where: { id: input.profileId } }) : null;
  if (input.profileId && !profile) throw notFound('Agente do workspace não encontrado.');
  const project = isAssistant ? null : await resolveProject(input, profile);
  const workspaceId = input.assistantWorkspaceId ?? project?.workspaceId ?? profile!.workspaceId;
  const workspace = project?.workspace ?? (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }));
  // Without a repository there is no code to deliver, so the agent reports a result.
  const output = project ? (profile?.output ?? 'PULL_REQUEST') : 'RESULT';

  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId } });
  if (!settings?.agentAccountId) {
    throw new HttpError(422, 'Configure a conta de agente (Claude) do workspace antes de lançar agentes.');
  }
  if (project && output === 'PULL_REQUEST') {
    const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
    if (!remote) throw new HttpError(422, 'O projeto não tem um remote "origin" válido para enviar o PR/MR.');
    await findGitAccount(workspaceId, remote);
  }
  if (!(await imageExists(config.agentRunnerImage))) {
    throw new HttpError(503, 'Imagem do agent-runner não encontrada. Rode: docker compose --profile tools build agent-runner');
  }
  if (!input.confirmHighUsage) {
    const usage = await getResourceUsage().catch(() => null);
    if (usage && usage.launchWarnings.length > 0) {
      throw new HttpError(409, 'O Studio está com consumo alto no Docker.', { code: 'HIGH_USAGE', warnings: usage.launchWarnings });
    }
  }

  // Where the copy comes from: the user's project, or another agent's copy to continue its work.
  const source = input.sourceAgentId ? await prisma.agent.findUnique({ where: { id: input.sourceAgentId } }) : null;
  if (input.sourceAgentId && (!source || source.projectId !== project?.id)) {
    throw new HttpError(422, 'Só é possível continuar o trabalho de um agente do mesmo projeto.');
  }
  const cloneFrom = project ? (source ? workdirPath(source.workdir) : toContainerPath(workspace.name, project.name)) : null;
  // Continuing another agent: same branch and PR (its base stays the PR base).
  const baseBranch = !project
    ? '-'
    : (source?.baseBranch ??
      input.pullRequest?.baseBranch ??
      (input.baseBranch?.trim() || project.baseBranch || (await currentBranch(cloneFrom!))));
  if (!baseBranch) {
    throw new HttpError(422, 'O projeto está sem branch atual (HEAD destacado). Informe a branch base.');
  }
  // With a base branch set on the project, agents work on nothing else (e.g. never "master" or "hom").
  if (project) assertWorkBase(project, baseBranch);

  const task = input.taskItemId ? await taskForAgent(workspaceId, input.taskItemId) : null;
  const prompt = input.prompt.trim();
  const message = task?.readme ? `${prompt}${BOARD_RULES_SEPARATOR}${task.readme.slice(0, MAX_BOARD_RULES)}` : prompt;
  const title = input.title?.trim() || (prompt.split('\n')[0] ?? prompt).slice(0, 80);
  const shortId = randomBytes(4).toString('hex');
  const slug = slugify(title);

  const agent = await prisma.agent.create({
    data: {
      workspaceId,
      projectId: project?.id ?? null,
      profileId: profile?.id ?? null,
      kind: isAssistant ? 'ASSISTANT' : 'TASK',
      title,
      model: input.model ?? (profile?.model as AgentModel | undefined) ?? 'sonnet',
      instructions: profile?.instructions ?? '',
      output,
      // Órbi reads everything and proposes changes; it only reads the board.
      tools: isAssistant ? ['studio', 'board_read'] : (profile?.tools ?? []),
      contextProjectIds: isAssistant ? [] : (profile?.contextProjectIds ?? []),
      autoConclude: input.autoConclude ?? profile?.autoConclude ?? false,
      autoMerge: input.autoMerge ?? profile?.autoMerge ?? false,
      baseBranch,
      branch: project ? (source?.branch ?? input.pullRequest?.branch ?? `agent/${slug ? `${slug}-` : ''}${shortId}`) : '-',
      ...(source?.prUrl && { prUrl: source.prUrl }),
      ...(input.pullRequest && { prUrl: input.pullRequest.url }),
      workdir: `${workspace.name}/${isAssistant ? 'orbi' : (project?.name ?? 'sem-repositorio')}-${shortId}`,
      ...(task && { taskItemId: task.item.id, taskRef: task.taskRef, taskUrl: task.item.url }),
      ...(input.workflowRunId && { workflowRunId: input.workflowRunId }),
    },
    include: agentInclude,
  });
  await addEvent(agent.id, 'user_message', { text: message });
  await prisma.agentInbox.create({ data: { agentId: agent.id, kind: 'MESSAGE', payload: { text: message } } });

  // A copy continuing another agent keeps that agent's branch; fresh copies follow the remote base.
  void prepareAndStart(agent.id, cloneFrom, project?.gitRemoteUrl ?? null, !source, source?.branch, Boolean(input.pullRequest));
  if (task) void reportTaskMove(agent, 'inProgress', true);
  return toResponse(agent);
}

async function reportTaskMove(agent: Agent, role: 'inProgress' | 'review' | 'done', assignSelf = false) {
  const message = await moveAgentTask(agent, role, { assignSelf });
  if (message) await addEvent(agent.id, 'status', { message });
}

async function prepareAndStart(
  agentId: string,
  projectDir: string | null,
  remoteUrl: string | null,
  followRemoteBase: boolean,
  cloneBranch?: string,
  /** The agent's branch is the branch of a PR made outside the Studio that only exists on the remote. */
  onRemoteBranch = false,
) {
  try {
    const agent = await findOrThrow(agentId);
    if (!projectDir) {
      await prepareEmptyWorkdir(agent.workdir);
      await prisma.agent.update({ where: { id: agentId }, data: { baseCommit: NO_REPOSITORY } });
      await addEvent(agentId, 'status', { message: 'Pasta de trabalho criada (agente sem repositório).' });
      await ensureContainer(agentId);
      return;
    }
    let { baseCommit } = await prepareWorkdir({
      projectDir,
      workdir: agent.workdir,
      baseBranch: agent.baseBranch,
      branch: agent.branch,
      remoteUrl,
      cloneBranch,
    });
    if (followRemoteBase && remoteUrl) {
      const updated = await updateFromRemote(agent, remoteUrl).catch(async (error: unknown) => {
        await addEvent(agentId, 'status', { message: `Não foi possível buscar a versão mais recente do remoto: ${errorMessage(error)}` });
        return null;
      });
      if (updated) {
        baseCommit = updated;
        await addEvent(agentId, 'status', {
          message: `Base atualizada para a versão mais recente de ${agent.baseBranch} no remoto (${updated.slice(0, 7)}).`,
        });
      }
    }
    if (onRemoteBranch && remoteUrl) {
      baseCommit = await checkoutFromRemote(agent, remoteUrl);
      await addEvent(agentId, 'status', { message: `Branch ${agent.branch} do PR/MR baixada do remoto (${baseCommit.slice(0, 7)}).` });
    }
    await prisma.agent.update({ where: { id: agentId }, data: { baseCommit } });
    await addEvent(agentId, 'status', {
      message: `Cópia isolada criada em ${workdirHostPath(agent.workdir)} na branch ${agent.branch}.`,
    });
    await ensureContainer(agentId);
  } catch (error) {
    await markFailed(agentId, error);
  }
}

/** Puts the copy on a branch that only exists on the remote (a PR/MR made outside the Studio), with the workspace credentials. */
async function checkoutFromRemote(agent: Agent, remoteUrl: string) {
  const remote = parseRemote(remoteUrl);
  if (!remote) throw new HttpError(422, 'O projeto não tem um remote válido.');
  const account = await findGitAccount(agent.workspaceId, remote);
  const token = secrets.decrypt(account.tokenEncrypted);
  return checkoutRemoteBranch({
    workdir: agent.workdir,
    branch: agent.branch,
    fetchUrl: authenticatedPushUrl(remote, account.provider as 'GITHUB' | 'GITLAB', token),
    token,
  });
}

/** Fetches the base branch from the remote with the workspace credentials (never stored in the copy). */
async function updateFromRemote(agent: Agent, remoteUrl: string) {
  const remote = parseRemote(remoteUrl);
  if (!remote) return null;
  const account = await findGitAccount(agent.workspaceId, remote).catch(() => null);
  if (!account) return null;
  const token = secrets.decrypt(account.tokenEncrypted);
  return updateToRemoteBase({
    workdir: agent.workdir,
    baseBranch: agent.baseBranch,
    fetchUrl: authenticatedPushUrl(remote, account.provider as 'GITHUB' | 'GITLAB', token),
    token,
  });
}

/**
 * Brings the latest base branch into an agent's copy so it can fix the conflicts of its PR/MR. Returns the files left
 * with conflicts (empty when git merged everything by itself).
 */
export async function mergeBaseIntoCopy(agentId: string) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, include: { project: true } });
  const remote = agent.project?.gitRemoteUrl ? parseRemote(agent.project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto não tem remote para buscar a base.');
  const account = await findGitAccount(agent.workspaceId, remote);
  const token = secrets.decrypt(account.tokenEncrypted);
  const provider = account.provider as 'GITHUB' | 'GITLAB';
  return mergeRemoteBase({
    workdir: agent.workdir,
    baseBranch: agent.baseBranch,
    fetchUrl: authenticatedPushUrl(remote, provider, token),
    token,
    author: {
      name: account.authorName || account.username,
      email: account.authorEmail || defaultAuthorEmail(provider, account.username, remoteHostname(remote)),
    },
  });
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
      contextProjects: await contextProjectsOf(agent),
      claudeToken: secrets.decrypt(settings.agentAccount.tokenEncrypted),
      skillIds: settings.enabledSkillIds,
      env: await testServicesEnv(agent.id, Boolean(agent.projectId)),
      variableNames: agent.kind === 'TASK' ? await writeAgentVariables(agent) : null,
    });
    await prisma.agent.update({ where: { id: agentId }, data: { containerId, secretHash } });
  } finally {
    starting.delete(agentId);
  }
}

/** Reference projects of an execution, as mounted read-only at /context/<name>. */
async function contextProjectsOf(agent: Agent) {
  if (agent.contextProjectIds.length === 0) return [];
  const projects = await prisma.project.findMany({
    where: { id: { in: agent.contextProjectIds }, workspaceId: agent.workspaceId, missingAt: null },
    include: { workspace: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  return Promise.all(
    projects.map(async (project) => ({
      name: project.name,
      hostPath: toHostPath(project.workspace.name, project.name),
      branch: project.isGitRepo ? await currentBranch(toContainerPath(project.workspace.name, project.name)) : null,
      baseBranch: project.baseBranch,
    })),
  );
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
  await removeAgentVariables(id);
  await prisma.agent.delete({ where: { id } });
}

// ---------------------------------------------------------------- finalize (commit + push + PR/MR)

export async function finalizeAgent(id: string) {
  const agent = await findOrThrow(id);
  if (agent.status !== 'READY_FOR_REVIEW') {
    throw new HttpError(409, 'Só é possível concluir um agente pronto para revisão.');
  }
  if (agent.output === 'RESULT' || !agent.projectId) {
    await completeWithResult(id);
    return getAgent(id);
  }

  await prisma.agent.update({ where: { id }, data: { status: 'FINALIZING', errorMessage: null } });
  await addEvent(id, 'status', { message: 'Enviando alterações...' });
  void finalizeInBackground(id);
  return getAgent(id);
}

/**
 * Finishing (commit, push, PR/MR, merge) runs inside the server, so a restart in the middle leaves the agent in
 * FINALIZING. Called at startup: every step can be repeated (nothing new to commit, same push, the PR is reused).
 */
export async function resumeFinalizing() {
  const agents = await prisma.agent.findMany({ where: { status: 'FINALIZING' }, select: { id: true } });
  for (const { id } of agents) {
    await addEvent(id, 'status', { message: 'Retomando o envio das alterações (o Studio reiniciou no meio).' });
    void finalizeInBackground(id);
  }
  return agents.length;
}

async function finalizeInBackground(id: string) {
  try {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id }, include: { project: true } });
    if (agent.containerId) {
      await stopAgentContainer(agent.containerId);
      await prisma.agent.update({ where: { id }, data: { containerId: null, secretHash: null } });
    }

    const remote = agent.project?.gitRemoteUrl ? parseRemote(agent.project.gitRemoteUrl) : null;
    if (!remote || !agent.baseCommit) throw new HttpError(422, 'O projeto não tem remote para enviar.');
    const account = await findGitAccount(agent.workspaceId, remote);
    const token = secrets.decrypt(account.tokenEncrypted);
    const provider = account.provider as 'GITHUB' | 'GITLAB';

    const body = await pullRequestBody(agent, remote);
    assertPushBranch(agent.project!, agent);

    // An agent that continues another one's open PR (e.g. a tester) finishes on that PR even without changes of its
    // own, so an approval still merges the work instead of ending as "no changes".
    const inheritedNumber = agent.prUrl ? pullRequestNumber(agent.prUrl) : null;
    const continuesOpenPr =
      inheritedNumber !== null && (await pullRequestState({ provider, remote, token, number: inheritedNumber }).catch(() => 'closed')) === 'open';

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
      allowUnchanged: continuesOpenPr,
    });
    await addEvent(id, 'status', { message: `Branch ${agent.branch} enviada.` });

    const prUrl = await openOrReusePullRequest(agent, { provider, remote, token, body });

    // A reported failure (e.g. a tester that found problems) keeps the PR open: only approved work is merged.
    if (agent.autoMerge && (agent.result as { status?: string } | null)?.status !== 'failure') {
      await mergeOwnPullRequest(agent, { provider, remote, token, prUrl, project: agent.project! });
      return;
    }

    await prisma.agent.update({
      where: { id },
      data: { status: 'COMPLETED', prUrl, finishedAt: new Date(), lastActivityAt: new Date() },
    });
    await addEvent(id, 'completed', { prUrl });
    await reportTaskMove(agent, 'review');
  } catch (error) {
    const message = errorMessage(error);
    // An automatic agent that changed nothing is done; there is just no PR to open.
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (agent?.autoConclude && message === NO_CHANGES_MESSAGE) {
      await prisma.agent.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          result: (agent.result as Prisma.JsonObject | null) ?? { status: 'success', summary: 'Concluído sem alterações de código.' },
          finishedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
      await addEvent(id, 'status', { message: 'Concluído sem alterações de código.' });
      return;
    }
    // Back to review so the user can fix the cause (e.g. a token) and try again.
    await prisma.agent.update({
      where: { id },
      data: { status: 'READY_FOR_REVIEW', errorMessage: message, lastActivityAt: new Date() },
    });
    await addEvent(id, 'error', { message });
  }
}

/** PR/MR description: the task the agent was given, plus "Closes #N" when the issue lives in the same repository. */
async function pullRequestBody(agent: Agent, remote: RemoteInfo) {
  const firstMessage = await prisma.agentEvent.findFirst({
    where: { agentId: agent.id, type: 'user_message' },
    orderBy: { id: 'asc' },
  });
  const firstText = (firstMessage?.data as { text?: string } | null)?.text ?? agent.title;
  const task = firstText.split(BOARD_RULES_SEPARATOR)[0]!;
  const closes = closingReference(agent.taskRef, remote.path);
  return `${task}${closes ? `\n\n${closes}` : ''}\n\n---\nGerado pelo Agents Manager Studio.`;
}

/** The agent's PR/MR while it is open; once merged (or closed), new commits on the branch go to a new one. */
async function openOrReusePullRequest(
  agent: Agent,
  input: { provider: 'GITHUB' | 'GITLAB'; remote: RemoteInfo; token: string; body: string },
) {
  const number = agent.prUrl ? pullRequestNumber(agent.prUrl) : null;
  if (agent.prUrl && number) {
    const state = await pullRequestState({ ...input, number }).catch(() => 'open' as const);
    if (state === 'open') return agent.prUrl;
  }
  return openPullRequest({ ...input, branch: agent.branch, baseBranch: agent.baseBranch, title: agent.title });
}

/**
 * Publishes an agent's copy while it keeps working (e.g. before a deploy it asked for): commits its changes,
 * pushes the branch and makes sure an open PR/MR carries what is not in the base branch yet.
 * `toMerge` is false when the base already has everything (nothing to merge before deploying).
 */
export async function publishAgentWork(agentId: string) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, include: { project: true } });
  const remote = agent.project?.gitRemoteUrl ? parseRemote(agent.project.gitRemoteUrl) : null;
  if (!remote || !agent.baseCommit) throw new HttpError(422, 'O projeto não tem remote para enviar.');
  const account = await findGitAccount(agent.workspaceId, remote);
  const token = secrets.decrypt(account.tokenEncrypted);
  const provider = account.provider as 'GITHUB' | 'GITLAB';
  const pushUrl = authenticatedPushUrl(remote, provider, token);
  const body = await pullRequestBody(agent, remote);
  assertPushBranch(agent.project!, agent);

  await commitAndPush({
    workdir: agent.workdir,
    baseCommit: agent.baseCommit,
    branch: agent.branch,
    message: { title: agent.title, body },
    author: {
      name: account.authorName || account.username,
      email: account.authorEmail || defaultAuthorEmail(provider, account.username, remoteHostname(remote)),
    },
    pushUrl,
    token,
    allowUnchanged: true,
  }).finally(() => returnToAgent(agent.workdir));
  const merged = await isMergedInto({ workdir: agent.workdir, baseBranch: agent.baseBranch, fetchUrl: pushUrl, token }).finally(() =>
    returnToAgent(agent.workdir),
  );
  if (merged) {
    return { toMerge: false, prUrl: agent.prUrl };
  }
  const prUrl = await openOrReusePullRequest(agent, { provider, remote, token, body });
  if (prUrl !== agent.prUrl) await prisma.agent.update({ where: { id: agentId }, data: { prUrl } });
  await addEvent(agentId, 'status', { message: `Branch ${agent.branch} enviada para o deploy (${prUrl}).` });
  return { toMerge: true, prUrl };
}

/**
 * Merges the PR/MR the agent just opened. A failed merge still completes the agent (the PR stays open for the
 * user), but its result becomes a failure, so a workflow stops at this step instead of going on without the merge.
 */
async function mergeOwnPullRequest(
  agent: Agent,
  input: { provider: 'GITHUB' | 'GITLAB'; remote: RemoteInfo; token: string; prUrl: string; project: { name: string; baseBranch: string | null } },
) {
  const result = (agent.result ?? {}) as Prisma.JsonObject;
  const number = pullRequestNumber(input.prUrl);
  try {
    if (!number) throw new HttpError(422, 'Não foi possível identificar o número do PR/MR.');
    await mergeIntoBase({ provider: input.provider, remote: input.remote, token: input.token, number, project: input.project, expectedBase: agent.baseBranch });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'COMPLETED', prUrl: input.prUrl, finishedAt: new Date(), lastActivityAt: new Date() },
    });
    await addEvent(agent.id, 'status', { message: 'Merge do PR/MR feito.' });
    await addEvent(agent.id, 'completed', { prUrl: input.prUrl });
    await reportTaskMove(agent, 'done');
  } catch (error) {
    const message = `PR/MR aberto, mas o merge falhou: ${errorMessage(error)}`;
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: 'COMPLETED',
        prUrl: input.prUrl,
        result: { ...result, status: 'failure', summary: message, mergeConflict: isConflictMessage(message) },
        finishedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
    await addEvent(agent.id, 'error', { message });
    await addEvent(agent.id, 'completed', { prUrl: input.prUrl });
    await reportTaskMove(agent, 'review');
  }
}

/**
 * Agents that deliver a result (no code) finish here: the result they reported through
 * studio_report_result, or the last answer when they did not report one.
 */
async function completeWithResult(id: string) {
  const agent = await findOrThrow(id);
  if (agent.containerId) {
    await stopAgentContainer(agent.containerId);
  }
  let result = agent.result as Prisma.JsonObject | null;
  if (!result || !('status' in result)) {
    const lastTurn = await prisma.agentEvent.findFirst({ where: { agentId: id, type: 'turn_end' }, orderBy: { id: 'desc' } });
    const summary = (lastTurn?.data as { text?: string } | null)?.text ?? '';
    result = { ...(result ?? {}), status: 'success', summary };
  }
  await prisma.agent.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      result,
      containerId: null,
      secretHash: null,
      finishedAt: new Date(),
      lastActivityAt: new Date(),
    },
  });
  await addEvent(id, 'status', { message: `Concluído: ${String(result.summary ?? '').slice(0, 300)}` });
}

/** Called when an agent finishes a turn with nothing queued: automatic agents conclude by themselves. */
export async function onAgentIdle(id: string) {
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent || agent.status !== 'READY_FOR_REVIEW' || !agent.autoConclude) return;
  // A turn that ended in error (e.g. the plan limit) is not a delivery: keep the work, the user resumes with a message.
  if (agent.errorMessage) {
    await addEvent(id, 'status', { message: 'Parou por erro (ex.: limite do plano). Nada foi enviado; mande uma mensagem (ex.: "continue") para retomar.' });
    return;
  }
  await finalizeAgent(id).catch((error: unknown) => addEvent(id, 'error', { message: errorMessage(error) }));
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

function toResponse(agent: Agent & Partial<Pick<AgentWithNames, 'project' | 'workspace' | 'workflowRun' | 'profile'>>) {
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
    workflowRunId: agent.workflowRunId,
    workflowName: agent.workflowRun?.workflow.name ?? null,
    profileId: agent.profileId,
    profileName: agent.profile?.name ?? null,
    output: agent.output,
    autoConclude: agent.autoConclude,
    hasRepository: agent.projectId !== null,
    result: agent.result,
    usage: usageOf(agent),
    errorMessage: agent.errorMessage,
    lastActivityAt: agent.lastActivityAt,
    createdAt: agent.createdAt,
    finishedAt: agent.finishedAt,
  };
}
