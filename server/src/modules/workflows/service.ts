import type { FastifyBaseLogger } from 'fastify';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { prisma } from '../../db.js';
import { type Prisma, Prisma as PrismaNamespace, type Workflow } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { hasBoard, syncWorkspaceBoard } from '../boards/service.js';
import { type ProfileFacts, type WorkflowStep, type WorkflowTrigger, validateSteps } from './definition.js';
import { advanceRun, cancelRun, parseSteps, parseTrigger, runBoardTriggers, startManualRun } from './engine.js';

export interface WorkflowInput {
  name: string;
  description: string;
  isEnabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  /** Older callers: agents of the first step. */
  maxConcurrentRuns?: number;
}

/**
 * The first step's agents and the old "runs at the same time" are the same number: a change to either sets both, so
 * older callers (Órbi, capacity suggestions) keep working.
 */
function withFirstStepAgents(steps: WorkflowStep[], maxConcurrentRuns: number | undefined) {
  if (maxConcurrentRuns === undefined || steps.length === 0) return steps;
  return steps.map((step, index) => (index === 0 ? { ...step, agents: maxConcurrentRuns } : step));
}

/** Same checks as saving; Órbi uses them to validate a proposal before showing it. */
export async function validateWorkflow(workspaceId: string, input: Pick<WorkflowInput, 'steps' | 'trigger'>) {
  const profileIds = input.steps.flatMap((step) => (step.kind === 'agent' ? [step.profileId] : []));
  const profiles = await prisma.agentProfile.findMany({ where: { id: { in: profileIds }, workspaceId } });
  const facts: ProfileFacts[] = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    hasRepository: profile.projectIds.length > 0 || profile.anyProject,
    deliversCode: (profile.projectIds.length > 0 || profile.anyProject) && profile.output === 'PULL_REQUEST',
    usesBoard: profile.tools.includes('board'),
  }));
  const problems = validateSteps(input.steps, facts);
  if (input.trigger.type !== 'manual' && !(await hasBoard(workspaceId))) {
    problems.push('Gatilhos do quadro precisam de um quadro vinculado ao workspace.');
  }
  if (problems.length > 0) throw new HttpError(422, problems.join(' '), problems);
}

function duplicateName(error: unknown) {
  return error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Per step: agents working it now and tasks waiting for a free agent there (their previous step done). Only the main
 * lane is counted; per-task lanes after a fan-out keep their own limit.
 */
async function stepLoad(workflow: Workflow, steps: WorkflowStep[]) {
  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: workflow.id, status: 'RUNNING' },
    select: { steps: { select: { stepId: true, status: true, lane: true, startedAt: true } } },
  });
  return steps.map((step, index) => {
    let active = 0;
    let queued = 0;
    for (const run of runs) {
      const latest = (stepId: string) =>
        run.steps.filter((entry) => entry.stepId === stepId && entry.lane === 'main').sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      const current = latest(step.id);
      if (current?.status === 'RUNNING') active++;
      else if (!current || current.status === 'RETRIED') {
        const previous = index === 0 ? null : latest(steps[index - 1]!.id);
        if (index > 0 && previous?.status === 'SUCCEEDED') queued++;
      }
    }
    return { stepId: step.id, agents: step.agents, active, queued };
  });
}

async function toResponse(workflow: Workflow) {
  const steps = parseSteps(workflow);
  const [running, total, load] = await Promise.all([
    prisma.workflowRun.count({ where: { workflowId: workflow.id, status: 'RUNNING' } }),
    prisma.workflowRun.count({ where: { workflowId: workflow.id } }),
    stepLoad(workflow, steps),
  ]);
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    description: workflow.description,
    isEnabled: workflow.isEnabled,
    trigger: parseTrigger(workflow),
    steps,
    maxConcurrentRuns: steps[0]?.agents ?? workflow.maxConcurrentRuns,
    /** Agents at work and tasks waiting, per step. */
    stepLoad: workflow.isEnabled ? load : load.map((entry) => ({ ...entry, active: 0 })),
    processId: workflow.processId,
    lastCheckedAt: workflow.lastCheckedAt,
    statusMessage: workflow.statusMessage,
    // A switched-off workflow's runs are paused, not running.
    runningRuns: workflow.isEnabled ? running : 0,
    totalRuns: total,
    createdAt: workflow.createdAt,
  };
}

export async function listWorkflows(workspaceId: string) {
  const workflows = await prisma.workflow.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  return Promise.all(workflows.map(toResponse));
}

export async function createWorkflow(workspaceId: string, input: WorkflowInput) {
  if (!(await prisma.workspace.findUnique({ where: { id: workspaceId } }))) throw notFound('Workspace não encontrado.');
  await validateWorkflow(workspaceId, input);
  // An older caller's "runs at the same time" fills the first step when it did not say how many agents it has.
  const steps = input.maxConcurrentRuns && input.steps[0]?.agents === 1 ? withFirstStepAgents(input.steps, input.maxConcurrentRuns) : input.steps;
  try {
    const workflow = await prisma.workflow.create({
      data: {
        workspaceId,
        ...input,
        maxConcurrentRuns: steps[0]?.agents ?? 1,
        trigger: input.trigger as Prisma.InputJsonValue,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
    return toResponse(workflow);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, `Já existe um workflow chamado "${input.name}".`);
    throw error;
  }
}

export async function updateWorkflow(id: string, input: Partial<WorkflowInput>) {
  const current = await findOrThrow(id);
  if (input.steps || input.trigger) {
    await validateWorkflow(current.workspaceId, { steps: input.steps ?? parseSteps(current), trigger: input.trigger ?? parseTrigger(current) });
  }
  // Steps sent win; otherwise an older caller's "runs at the same time" becomes the first step's agents.
  const steps = input.steps ?? (input.maxConcurrentRuns !== undefined ? withFirstStepAgents(parseSteps(current), input.maxConcurrentRuns) : undefined);
  try {
    const workflow = await prisma.workflow.update({
      where: { id },
      data: {
        ...input,
        ...(steps && { maxConcurrentRuns: steps[0]?.agents ?? 1 }),
        ...(input.trigger && { trigger: input.trigger as Prisma.InputJsonValue }),
        ...(steps && { steps: steps as unknown as Prisma.InputJsonValue }),
        statusMessage: input.isEnabled === false ? 'Desativado.' : current.statusMessage,
      },
    });
    return toResponse(workflow);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, `Já existe um workflow chamado "${input.name}".`);
    throw error;
  }
}

/** Runs keep their history; agents they launched keep existing. */
export async function deleteWorkflow(id: string) {
  await findOrThrow(id);
  await prisma.workflow.delete({ where: { id } });
}

/** Starts a run from a conversation in the Studio; board workflows can also be checked right away. */
export async function startWorkflow(id: string, message: string | undefined, log?: FastifyBaseLogger) {
  const workflow = await findOrThrow(id);
  if (!workflow.isEnabled) throw new HttpError(409, 'Ative o workflow antes de iniciar.');
  const trigger = parseTrigger(workflow);
  if (trigger.type === 'manual') {
    if (!message?.trim()) throw new HttpError(400, 'Escreva a mensagem que inicia o workflow.');
    const run = await startManualRun(workflow, message, log);
    return { runId: run.id };
  }
  if (await hasBoard(workflow.workspaceId)) await syncWorkspaceBoard(workflow.workspaceId).catch(() => undefined);
  await runBoardTriggers(workflow.workspaceId, log, workflow.id);
  return { runId: null };
}

// ---------------------------------------------------------------- runs

const runInclude = {
  workflow: { select: { name: true, steps: true } },
  steps: { orderBy: [{ stepIndex: 'asc' }, { attempt: 'asc' }] },
} satisfies Prisma.WorkflowRunInclude;

type RunWithDetails = Prisma.WorkflowRunGetPayload<{ include: typeof runInclude }>;

/** Ids of the user's workspaces that the active view profile shows (runs only carry the workspace id). */
export async function visibleWorkspaceIdsOf(userId: string) {
  const workspaces = await prisma.workspace.findMany({ where: { ownerId: userId, ...(await visibleWorkspaceFilter(userId)) }, select: { id: true } });
  return workspaces.map((workspace) => workspace.id);
}

/** Board tasks a run works on: the task that started it, the tasks of a feature test and the per-task lanes. */
export function runTaskIds(run: Pick<RunWithDetails, 'taskItemId' | 'trigger' | 'steps'>) {
  const trigger = (run.trigger ?? {}) as { taskItemIds?: string[] };
  const ids = [run.taskItemId, ...(trigger.taskItemIds ?? []), ...run.steps.map((step) => step.lane).filter((lane) => lane !== 'main')];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Tasks that active runs are working on, over the workspaces the user sees (to light their cards up). */
export async function activeRunTasks(userId: string) {
  const runs = await prisma.workflowRun.findMany({
    // A card lights up while one of its run's agents works, even after the run ended (e.g. resumed by a message to
    // finish a decision) or with the workflow switched off (finishing what it had started). Between steps, only a
    // switched-on workflow's run lights its cards: a switched-off one counts as paused.
    where: {
      OR: [
        { status: 'RUNNING', workflow: { isEnabled: true } },
        { agents: { some: { status: { in: ['PREPARING', 'RUNNING', 'WAITING_INPUT'] } } } },
      ],
      workspaceId: { in: await visibleWorkspaceIdsOf(userId) },
    },
    include: { steps: { select: { lane: true } } },
  });
  // A run still in the queue for its first step (the machine or the plan holding new work) has no agent yet: its card
  // does not light up as if one were working.
  return runs
    .filter((run) => run.steps.length > 0)
    .flatMap((run) => runTaskIds(run as never).map((taskItemId) => ({ workspaceId: run.workspaceId, taskItemId, runId: run.id })));
}

async function runResponse(run: RunWithDetails) {
  const agentIds = run.steps.flatMap((step) => (step.agentId ? [step.agentId] : []));
  const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, status: true, title: true, profile: { select: { name: true } } } });
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflow.name,
    workspaceId: run.workspaceId,
    title: run.title,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    definition: parseSteps(run.workflow).map((step) => ({ id: step.id, name: step.name, kind: step.kind })),
    taskItemIds: runTaskIds(run),
    steps: run.steps.map((step) => ({
      id: step.id,
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      lane: step.lane,
      attempt: step.attempt,
      status: step.status,
      agentId: step.agentId,
      agentStatus: agents.find((agent) => agent.id === step.agentId)?.status ?? null,
      /** Workspace agent that ran the step (e.g. "game-builder"). */
      agentName: agents.find((agent) => agent.id === step.agentId)?.profile?.name ?? null,
      deploymentId: step.deploymentId,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
  };
}

export async function listRuns(workspaceId: string, workflowId?: string) {
  const runs = await prisma.workflowRun.findMany({
    where: { workspaceId, ...(workflowId && { workflowId }) },
    include: runInclude,
    orderBy: { startedAt: 'desc' },
    take: 30,
  });
  return Promise.all(runs.map(runResponse));
}

/** Running workflow runs over the workspaces the user sees (general dashboard), with the workspace name. */
export async function listActiveRuns(userId: string) {
  const runs = await prisma.workflowRun.findMany({
    where: { status: 'RUNNING', workflow: { isEnabled: true }, workspaceId: { in: await visibleWorkspaceIdsOf(userId) } },
    include: runInclude,
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
  const workspaces = await prisma.workspace.findMany({ where: { id: { in: runs.map((run) => run.workspaceId) } }, select: { id: true, name: true } });
  const nameOf = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name ?? '';
  return Promise.all(runs.map(async (run) => ({ ...(await runResponse(run)), workspaceName: nameOf(run.workspaceId) })));
}

export async function getRun(id: string) {
  const run = await prisma.workflowRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw notFound('Execução não encontrada.');
  return runResponse(run);
}

export async function cancelWorkflowRun(id: string, log?: FastifyBaseLogger) {
  await cancelRun(id);
  await advanceRun(id, log);
  return getRun(id);
}

async function findOrThrow(id: string) {
  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow) throw notFound('Workflow não encontrado.');
  return workflow;
}
