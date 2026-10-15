import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { stopAgentContainer } from '../agents/runtime.js';
import { agentMedia, answerQuestion, getAgent, listAgentEvents, mergeBaseIntoCopy, sendMessage } from '../agents/service.js';
import { decideCapacitySuggestion } from '../capacity/service.js';
import { listStuckTasks } from '../board-watch/service.js';
import { getResourceUsage } from '../system/service.js';
import { listTestEnvs, testEnvCapacity } from '../test-envs/service.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import type { WorkflowStep } from '../workflows/definition.js';
import { parseSteps } from '../workflows/engine.js';
import { updateWorkflow } from '../workflows/service.js';
import { listOpenFlags, logActivity, resolveFlag } from './activity.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findTaskPullRequest } from '../agents/task-pull-request.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { secrets } from '../../lib/secrets.js';
import { boardContext } from '../boards/service.js';

/**
 * Órbi's direct operations: the day-to-day work the user would otherwise do by hand (answer an agent, message it,
 * switch a workflow, pause a workspace, decide a capacity suggestion, send a conflict back). Each one is logged as
 * activity. Structural changes (agents, workflows) stay as proposals (assistant/proposals.ts).
 */

type Args = Record<string, unknown>;

const PAUSED_KEY = 'orbiPaused';
const APPROVAL_NOTE = ' — respondido pelo Órbi em nome do usuário.';
const RESUME_MESSAGE =
  'O seu trabalho foi pausado (o container parou) e agora continua. Confira o estado da sua cópia (git status, arquivos gerados; ' +
  'reinstale dependências se a pasta estiver vazia) e siga a tarefa exatamente de onde parou até o fim.';
const IMAGE_MAX_BYTES = 4_000_000;

interface PausedWorkspace {
  workflowIds: string[];
  agentIds: string[];
  at: string;
}

export interface Caller {
  /** The Órbi conversation calling the tool (null when the Studio itself acts, e.g. around a disk compaction). */
  conversationId: string | null;
  ownerId: string;
}

const text = (value: unknown, max = 20_000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Workspaces Órbi can act on: all of the user's (the view profile only filters what the screens show). */
export async function ownerWorkspaces(ownerId: string) {
  return prisma.workspace.findMany({ where: { ownerId, isIgnored: false, missingAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

export async function resolveWorkspace(ownerId: string, ref: unknown) {
  const wanted = text(ref, 200).toLowerCase();
  const workspaces = await ownerWorkspaces(ownerId);
  const found = workspaces.find((workspace) => workspace.id === wanted || workspace.name.toLowerCase() === wanted);
  if (!found) throw new HttpError(404, `Workspace "${String(ref)}" não encontrado. Workspaces: ${workspaces.map((workspace) => workspace.name).join(', ')}.`);
  return found;
}

/** An execution (agent) of one of the user's workspaces; never another Órbi conversation. */
async function ownedAgent(ownerId: string, id: unknown) {
  const agent = await prisma.agent.findUnique({ where: { id: text(id, 60) }, include: { workspace: { select: { ownerId: true, name: true } } } });
  if (!agent || agent.workspace.ownerId !== ownerId) throw notFound(`Execução "${String(id)}" não encontrada.`);
  if (agent.kind === 'ASSISTANT') throw new HttpError(400, 'Essa é uma conversa do Órbi, não uma execução de agente.');
  return agent;
}

async function pausedState(ownerId: string) {
  return (await getUserSetting<Record<string, PausedWorkspace>>(ownerId, PAUSED_KEY)) ?? {};
}

// ---------------------------------------------------------------- reading

interface PendingQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** What waits for someone: agent questions, recent failed runs, capacity suggestions, flags. */
export async function pendingItems(ownerId: string, workspaceIds: string[]) {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [waiting, failed, capacity, flags] = await Promise.all([
    prisma.agent.findMany({
      where: { workspaceId: { in: workspaceIds }, kind: 'TASK', status: 'WAITING_INPUT' },
      select: { id: true, title: true, workspaceId: true, pendingQuestion: true, lastActivityAt: true, taskRef: true },
      orderBy: { lastActivityAt: 'asc' },
    }),
    prisma.workflowRun.findMany({
      where: { workspaceId: { in: workspaceIds }, status: 'FAILED', finishedAt: { gte: since } },
      select: { id: true, title: true, error: true, finishedAt: true, workspaceId: true, taskItemId: true, workflow: { select: { name: true } } },
      orderBy: { finishedAt: 'desc' },
    }),
    prisma.capacityReview.findMany({
      where: { status: 'pending', workspaceId: { in: workspaceIds } },
      select: { id: true, summary: true, workspaceId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    listOpenFlags(ownerId),
  ]);
  // A failed run whose task already has a newer run is not pending anymore.
  const newer = await prisma.workflowRun.findMany({
    where: { taskItemId: { in: failed.flatMap((run) => (run.taskItemId ? [run.taskItemId] : [])) }, status: { in: ['RUNNING', 'COMPLETED'] } },
    select: { taskItemId: true, startedAt: true },
  });
  const failedRuns = failed.filter(
    (run) => !run.taskItemId || !newer.some((entry) => entry.taskItemId === run.taskItemId && entry.startedAt > run.finishedAt!),
  );
  // The step that failed tells which execution to look at.
  const failedSteps = await prisma.workflowStepRun.findMany({
    where: { runId: { in: failedRuns.map((run) => run.id) }, status: 'FAILED' },
    select: { runId: true, agentId: true, error: true },
  });
  return {
    questions: waiting.map((agent) => ({
      agentId: agent.id,
      title: agent.title,
      workspaceId: agent.workspaceId,
      task: agent.taskRef,
      waitingSince: agent.lastActivityAt,
      questions: (Array.isArray(agent.pendingQuestion) ? agent.pendingQuestion : []) as unknown as PendingQuestion[],
    })),
    failedRuns: failedRuns.map((run) => {
      const step = failedSteps.find((entry) => entry.runId === run.id);
      return {
        runId: run.id,
        workflow: run.workflow.name,
        title: run.title,
        workspaceId: run.workspaceId,
        error: step?.error ?? run.error,
        executionId: step?.agentId ?? null,
        finishedAt: run.finishedAt,
      };
    }),
    capacitySuggestions: capacity.map((review) => ({
      proposalId: review.id,
      summary: review.summary ?? '',
      workspaceId: review.workspaceId,
      createdAt: review.createdAt,
    })),
    flags: flags.filter((flag) => !flag.workspaceId || workspaceIds.includes(flag.workspaceId)),
  };
}

export async function overview(ownerId: string) {
  const workspaces = await ownerWorkspaces(ownerId);
  const ids = workspaces.map((workspace) => workspace.id);
  const [workflows, running, active, pending, paused, resources, testEnvs, accounts] = await Promise.all([
    prisma.workflow.groupBy({ by: ['workspaceId', 'isEnabled'], where: { workspaceId: { in: ids } }, _count: true }),
    prisma.workflowRun.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: ids }, status: 'RUNNING' }, _count: true }),
    prisma.agent.findMany({
      where: { workspaceId: { in: ids }, kind: 'TASK', status: { in: ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'FINALIZING'] } },
      select: { id: true, title: true, status: true, workspaceId: true, containerId: true, limitResumeAt: true },
    }),
    pendingItems(ownerId, ids),
    pausedState(ownerId),
    getResourceUsage().catch(() => null),
    testEnvCapacity().catch(() => null),
    prisma.agentAccount.findMany({ where: { ownerId }, select: { label: true, planUsage: true, planUsageAt: true } }),
  ]);
  const count = (workspaceId: string, enabled: boolean) =>
    workflows.find((entry) => entry.workspaceId === workspaceId && entry.isEnabled === enabled)?._count ?? 0;
  return {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      workflowsOn: count(workspace.id, true),
      workflowsOff: count(workspace.id, false),
      pausedByOrbi: paused[workspace.id] ? paused[workspace.id]!.at : null,
      runningRuns: running.find((entry) => entry.workspaceId === workspace.id)?._count ?? 0,
      agents: active
        .filter((agent) => agent.workspaceId === workspace.id)
        .map((agent) => ({
          id: agent.id,
          title: agent.title,
          status: agent.status,
          // RUNNING without a container: stopped mid-work (a pause, the computer shut down) or waiting for the plan.
          containerRunning: agent.containerId !== null,
          waitingPlanUntil: agent.limitResumeAt,
        })),
      waitingQuestions: pending.questions.filter((entry) => entry.workspaceId === workspace.id).length,
      failedRuns24h: pending.failedRuns.filter((entry) => entry.workspaceId === workspace.id).length,
      capacitySuggestions: pending.capacitySuggestions.filter((entry) => entry.workspaceId === workspace.id).length,
    })),
    machine: resources
      ? {
          memoryPercent: Math.round(resources.host?.memoryPercent ?? resources.totals.memoryPercent),
          dockerMemoryPercent: Math.round(resources.totals.memoryPercent),
          cpuPercent: Math.round(resources.host?.cpuPercent ?? resources.totals.cpuPercent),
          runningAgents: resources.totals.runningAgents,
          launchLimitMemoryPercent: resources.limits.memoryPercent,
          warnings: resources.launchWarnings,
        }
      : null,
    testEnvironments: testEnvs,
    plan: accounts.map((account) => ({ account: account.label, usage: account.planUsage, at: account.planUsageAt })),
  };
}

async function agentDetail(ownerId: string, id: unknown) {
  const agent = await ownedAgent(ownerId, id);
  const view = await getAgent(agent.id);
  const events = await listAgentEvents(agent.id, 0);
  const tail = events.slice(-30).map((event) => ({ type: event.type, at: event.createdAt, data: event.data }));
  const media = [...new Set(JSON.stringify([agent.pendingQuestion, tail]).match(/\/api\/agents\/[0-9a-f-]{36}\/files\/[^\s"'\\)]+/g) ?? [])];
  return {
    id: agent.id,
    title: agent.title,
    workspace: agent.workspace.name,
    status: agent.status,
    agent: view.profileName,
    project: view.projectName,
    task: agent.taskRef,
    prUrl: agent.prUrl,
    error: agent.errorMessage,
    containerRunning: agent.containerId !== null,
    pendingQuestion: agent.pendingQuestion,
    result: agent.result,
    // Previews the agent showed (images, sounds): open them with studio_view_file.
    media,
    timeline: tail,
  };
}

/** An image from an agent's copy, returned as an image the model can look at; sounds only by their size. */
async function viewFile(ownerId: string, args: Args) {
  const url = text(args.url, 2000);
  const fromUrl = /\/api\/agents\/([0-9a-f-]{36})\/files\/(.+)$/.exec(url);
  const agentId = fromUrl?.[1] ?? text(args.agentId, 60);
  const relative = fromUrl?.[2] ?? text(args.path, 1000);
  const agent = await ownedAgent(ownerId, agentId);
  const file = await agentMedia(agent.id, relative);
  if (file.contentType.startsWith('audio/')) {
    return { audio: true, contentType: file.contentType, sizeBytes: file.content.length, note: 'Você não ouve áudio: avalie pelos dados técnicos que o agente informou e deixe a escuta para o usuário.' };
  }
  if (file.content.length > IMAGE_MAX_BYTES) throw new HttpError(413, 'Imagem grande demais para ver aqui.');
  return { image: { mimeType: file.contentType, data: file.content.toString('base64') } };
}

// ---------------------------------------------------------------- acting

async function answer(caller: Caller, args: Args) {
  const agent = await ownedAgent(caller.ownerId, args.agentId);
  if (agent.status !== 'WAITING_INPUT' || !Array.isArray(agent.pendingQuestion)) throw new HttpError(409, 'Essa execução não está esperando resposta.');
  const questions = agent.pendingQuestion as unknown as PendingQuestion[];
  const given = Array.isArray(args.answers) ? args.answers.map((entry) => text(entry, 5000)) : [];
  if (given.length !== questions.length || given.some((entry) => !entry)) {
    throw new HttpError(400, `Mande uma resposta para cada pergunta, na ordem (${questions.length}).`);
  }
  const answers = Object.fromEntries(questions.map((question, index) => [question.question, `${given[index]}${APPROVAL_NOTE}`]));
  await answerQuestion(agent.id, answers);
  await logActivity({
    ...activityBase(caller, agent.workspaceId),
    kind: 'answer',
    summary: `Respondeu "${agent.title}": ${given.join(' · ').slice(0, 300)}`,
    details: { questions: questions.map((question) => question.question), answers: given, reason: text(args.reason, 2000) || null },
    link: `/agents/${agent.id}`,
  });
  return { ok: true, message: 'Resposta enviada; o agente continua.' };
}

function activityBase(caller: Caller, workspaceId: string | null) {
  return { ownerId: caller.ownerId, conversationId: caller.conversationId, workspaceId };
}

async function message(caller: Caller, args: Args) {
  const agent = await ownedAgent(caller.ownerId, args.agentId);
  const body = text(args.text);
  if (!body) throw new HttpError(400, 'Escreva a mensagem.');
  await sendMessage(agent.id, body);
  await logActivity({ ...activityBase(caller, agent.workspaceId), kind: 'message', summary: `Mensagem para "${agent.title}"`, details: { text: body }, link: `/agents/${agent.id}` });
  return { ok: true, message: 'Mensagem entregue; o agente volta a trabalhar.' };
}

async function setWorkflow(caller: Caller, args: Args) {
  const workflow = await prisma.workflow.findUnique({ where: { id: text(args.workflowId, 60) }, include: { workspace: { select: { ownerId: true } } } });
  if (!workflow || workflow.workspace.ownerId !== caller.ownerId) throw notFound('Workflow não encontrado.');
  const changes: { isEnabled?: boolean; maxConcurrentRuns?: number; steps?: WorkflowStep[] } = {};
  if (typeof args.enabled === 'boolean') changes.isEnabled = args.enabled;
  // Agents per step, by step id or name: {"Revisar": 2}.
  if (args.stepAgents && typeof args.stepAgents === 'object') {
    const wanted = args.stepAgents as Record<string, unknown>;
    const steps = parseSteps(workflow);
    for (const [key, value] of Object.entries(wanted)) {
      const step = steps.find((entry) => entry.id === key || entry.name.toLowerCase() === key.toLowerCase());
      const count = Number(value);
      if (!step) throw new HttpError(404, `Etapa "${key}" não existe. Etapas: ${steps.map((entry) => entry.name).join(', ')}.`);
      if (!Number.isInteger(count) || count < 1 || count > 5) throw new HttpError(400, 'Os agentes de uma etapa vão de 1 a 5.');
      step.agents = count;
    }
    changes.steps = steps;
  }
  if (args.maxConcurrentRuns !== undefined) {
    const value = Number(args.maxConcurrentRuns);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new HttpError(400, 'maxConcurrentRuns vai de 1 a 5.');
    changes.maxConcurrentRuns = value;
  }
  if (Object.keys(changes).length === 0) throw new HttpError(400, 'Diga o que mudar: enabled, maxConcurrentRuns (agentes da primeira etapa) e/ou stepAgents.');
  await updateWorkflow(workflow.id, changes);
  const parts = [
    ...(changes.isEnabled !== undefined ? [changes.isEnabled ? 'ligou' : 'desligou'] : []),
    ...(changes.maxConcurrentRuns !== undefined ? [`${changes.maxConcurrentRuns} agente(s) na primeira etapa`] : []),
    ...(changes.steps ? [`agentes por etapa: ${changes.steps.map((step) => `${step.name} ${step.agents}`).join(', ')}`] : []),
  ];
  await logActivity({ ...activityBase(caller, workflow.workspaceId), kind: 'workflow', summary: `Workflow "${workflow.name}": ${parts.join(', ')}`, details: { reason: text(args.reason, 2000) || null } });
  return { ok: true, workflow: workflow.name, ...changes };
}

/** Switches the workspace's workflows off (remembering which were on) and, optionally, stops its working agents. */
export async function pauseWorkspace(caller: Caller, args: Args) {
  const workspace = await resolveWorkspace(caller.ownerId, args.workspace);
  const state = await pausedState(caller.ownerId);
  const workflows = await prisma.workflow.findMany({ where: { workspaceId: workspace.id, isEnabled: true }, select: { id: true } });
  for (const workflow of workflows) await updateWorkflow(workflow.id, { isEnabled: false });
  const stopAgents = args.stopAgents !== false;
  const agents = stopAgents
    ? await prisma.agent.findMany({
        where: { workspaceId: workspace.id, kind: 'TASK', containerId: { not: null }, status: { in: ['PREPARING', 'RUNNING', 'WAITING_INPUT'] } },
        select: { id: true, containerId: true },
      })
    : [];
  for (const agent of agents) {
    // The container is detached first, so the agent monitor does not take the stop for a crash and resume it.
    const detached = await prisma.agent.updateMany({ where: { id: agent.id, containerId: agent.containerId }, data: { containerId: null, secretHash: null } });
    if (detached.count > 0) await stopAgentContainer(agent.containerId!).catch(() => undefined);
  }
  const previous = state[workspace.id];
  state[workspace.id] = {
    workflowIds: [...new Set([...(previous?.workflowIds ?? []), ...workflows.map((workflow) => workflow.id)])],
    agentIds: [...new Set([...(previous?.agentIds ?? []), ...agents.map((agent) => agent.id)])],
    at: new Date().toISOString(),
  };
  await setUserSetting(caller.ownerId, PAUSED_KEY, state);
  await logActivity({
    ...activityBase(caller, workspace.id),
    kind: 'pause',
    summary: `Pausou ${workspace.name}: ${workflows.length} workflow(s) desligado(s), ${agents.length} agente(s) parado(s)`,
    details: { reason: text(args.reason, 2000) || null },
  });
  return { ok: true, workspace: workspace.name, workflowsSwitchedOff: workflows.length, agentsStopped: agents.length };
}

/** Switches back on what the pause switched off and resumes the agents it stopped. */
export async function resumeWorkspace(caller: Caller, args: Args) {
  const workspace = await resolveWorkspace(caller.ownerId, args.workspace);
  const state = await pausedState(caller.ownerId);
  const paused = state[workspace.id];
  if (!paused) throw new HttpError(409, `${workspace.name} não foi pausado pelo Órbi. Para ligar workflows um a um, use studio_set_workflow.`);
  const resumeWorkflows = args.workflows !== false;
  if (resumeWorkflows) {
    for (const id of paused.workflowIds) await updateWorkflow(id, { isEnabled: true }).catch(() => undefined);
  }
  const agents = await prisma.agent.findMany({
    where: { id: { in: paused.agentIds }, containerId: null, status: { in: ['PREPARING', 'RUNNING'] } },
    select: { id: true },
  });
  for (const agent of agents) await sendMessage(agent.id, RESUME_MESSAGE).catch(() => undefined);
  delete state[workspace.id];
  await setUserSetting(caller.ownerId, PAUSED_KEY, state);
  await logActivity({
    ...activityBase(caller, workspace.id),
    kind: 'resume',
    summary: `Retomou ${workspace.name}: ${resumeWorkflows ? paused.workflowIds.length : 0} workflow(s) religado(s), ${agents.length} agente(s) retomado(s)`,
    details: { reason: text(args.reason, 2000) || null },
  });
  return { ok: true, workspace: workspace.name, workflowsSwitchedOn: resumeWorkflows ? paused.workflowIds.length : 0, agentsResumed: agents.length };
}

/** A pending suggestion of the Gestor de Capacidade (when the pilot was off), applied or discarded. */
async function decideCapacity(caller: Caller, args: Args) {
  const decision = args.decision === 'discard' ? 'discard' : 'apply';
  return decideCapacitySuggestion(caller.ownerId, text(args.proposalId, 60), decision, { conversationId: caller.conversationId ?? undefined, reason: text(args.reason, 2000) || undefined });
}

/** A real merge conflict goes back to the agent that built the work: the base is merged into its copy and it resolves. */
async function conflictBack(caller: Caller, args: Args) {
  const agent = await ownedAgent(caller.ownerId, args.agentId);
  if (agent.workdirRemovedAt) throw new HttpError(409, 'A cópia desse agente já foi removida.');
  const conflicts = await mergeBaseIntoCopy(agent.id);
  const lines = [
    'O seu PR/MR não pôde ser mesclado: outras tarefas foram entregues na branch de destino e mexeram nos mesmos arquivos.',
    '',
    conflicts.length > 0
      ? `O Studio trouxe a versão mais recente da branch de destino para a sua cópia (merge em andamento). Ficaram com conflito:\n${conflicts.map((file) => `- ${file}`).join('\n')}\n\nJunte as versões mantendo as duas mudanças: tire todos os marcadores (<<<<<<<, =======, >>>>>>>), não rode "git merge --abort" nem faça commit, e confira com o build, os testes ou os seus scripts que tudo continua certo.`
      : 'O Studio trouxe a versão mais recente da branch de destino para a sua cópia e o git juntou tudo sem conflito de texto. Rode de novo o build, os testes ou os scripts e corrija o que quebrar.',
    '',
    'Depois, termine de novo; o Studio envia para o mesmo PR/MR e tenta o merge outra vez. Não precisa pedir aprovação de novo, a menos que o resultado visível mude.',
  ];
  await sendMessage(agent.id, lines.join('\n'));
  await logActivity({
    ...activityBase(caller, agent.workspaceId),
    kind: 'conflict',
    summary: `Devolveu o conflito de "${agent.title}" ao agente (${conflicts.length} arquivo(s))`,
    details: { conflicts },
    link: `/agents/${agent.id}`,
  });
  return { ok: true, conflicts };
}

async function flag(caller: Caller, workspaceId: string, args: Args) {
  const summary = text(args.summary, 500);
  if (!summary) throw new HttpError(400, 'Diga em uma frase o que o usuário precisa ver.');
  const workspace = args.workspace ? await resolveWorkspace(caller.ownerId, args.workspace) : { id: workspaceId };
  const created = await logActivity({
    ...activityBase(caller, workspace.id),
    kind: 'flag',
    summary,
    details: { details: text(args.details) || null },
    link: text(args.link, 500) || null,
  });
  return { ok: true, id: created.id, message: 'Deixei o aviso para o usuário na página do Órbi.' };
}

/** Marks a flag as dealt with (after sorting it out with the user). */
async function resolveFlagOp(caller: Caller, args: Args) {
  const flag = await resolveFlag(caller.ownerId, text(args.id, 60));
  return { ok: true, id: flag.id, message: 'Pendência marcada como resolvida.' };
}

/** The PR/MR of a board task in the focused workspace: the open one, or the latest merged. */
async function taskPullRequest(workspaceId: string, args: Args) {
  const { snapshot, repos } = await boardContext(workspaceId);
  const wanted = text(args.id, 300);
  const item = snapshot.items.find((entry) => entry.id === wanted || (entry.repository && entry.number && `${entry.repository}#${entry.number}` === wanted));
  if (!item?.repository || !item.number) throw new HttpError(404, 'Tarefa não encontrada (use o id ou a ref repo#N de board_list_tasks).');
  const repo = repos.find((entry) => entry.path === item.repository);
  const project = repo?.projectId ? await prisma.project.findUnique({ where: { id: repo.projectId } }) : null;
  const remote = project?.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto da tarefa não tem remote.');
  const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
  const pullRequest = await findTaskPullRequest({
    provider: account.provider as 'GITHUB' | 'GITLAB',
    remote,
    token: secrets.decrypt(account.tokenEncrypted),
    issueNumber: item.number,
    knownNumbers: item.pullRequests.map((pr) => pr.number),
  });
  return pullRequest ?? { message: 'Nenhum PR/MR cita esta tarefa.' };
}

/** Moves the conversation's focus: the board and workspace tools then act on that workspace. */
async function focus(caller: Caller, args: Args) {
  const workspace = await resolveWorkspace(caller.ownerId, args.workspace);
  if (!caller.conversationId) throw new HttpError(400, 'Só uma conversa do Órbi muda de foco.');
  await prisma.agent.update({ where: { id: caller.conversationId }, data: { workspaceId: workspace.id } });
  return { ok: true, workspace: workspace.name, message: `Agora as ferramentas do quadro e do workspace atuam em ${workspace.name}.` };
}

export const ORBI_OPS_TOOLS = [
  'studio_overview',
  'studio_focus',
  'studio_pending',
  'studio_agent',
  'studio_view_file',
  'studio_answer',
  'studio_message',
  'studio_set_workflow',
  'studio_pause',
  'studio_resume',
  'studio_capacity',
  'studio_conflict_back',
  'studio_flag',
  'studio_resources',
  'studio_resolve_flag',
  'studio_task_pull_request',
] as const;

export async function runOrbiOp(caller: Caller, workspaceId: string, name: string, args: Args) {
  switch (name) {
    case 'studio_overview':
      return overview(caller.ownerId);
    case 'studio_focus':
      return focus(caller, args);
    case 'studio_pending': {
      const ids = args.all === true ? (await ownerWorkspaces(caller.ownerId)).map((workspace) => workspace.id) : [workspaceId];
      const pending = await pendingItems(caller.ownerId, ids);
      const stuck = (await listStuckTasks(caller.ownerId).catch(() => [])).filter((task) => ids.includes(task.workspaceId));
      return { ...pending, stuckTasks: stuck };
    }
    case 'studio_agent':
      return agentDetail(caller.ownerId, args.id);
    case 'studio_view_file':
      return viewFile(caller.ownerId, args);
    case 'studio_answer':
      return answer(caller, args);
    case 'studio_message':
      return message(caller, args);
    case 'studio_set_workflow':
      return setWorkflow(caller, args);
    case 'studio_pause':
      return pauseWorkspace(caller, args);
    case 'studio_resume':
      return resumeWorkspace(caller, args);
    case 'studio_capacity':
      return decideCapacity(caller, args);
    case 'studio_conflict_back':
      return conflictBack(caller, args);
    case 'studio_flag':
      return flag(caller, workspaceId, args);
    case 'studio_resolve_flag':
      return resolveFlagOp(caller, args);
    case 'studio_task_pull_request':
      return taskPullRequest(workspaceId, args);
    case 'studio_resources': {
      const [usage, environments, capacity] = await Promise.all([getResourceUsage(), listTestEnvs({ active: true }), testEnvCapacity().catch(() => null)]);
      return {
        host: usage.host && { cpuPercent: usage.host.cpuPercent, memoryPercent: usage.host.memoryPercent, disks: usage.host.disks },
        docker: usage.totals,
        limits: usage.limits,
        warnings: usage.launchWarnings,
        testEnvironments: environments,
        testEnvCapacity: capacity,
      };
    }
  }
  throw new HttpError(400, `Ferramenta desconhecida: ${name}.`);
}
