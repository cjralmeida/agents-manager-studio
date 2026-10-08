import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { type Prisma, Prisma as PrismaNamespace, type Workflow } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { syncBoard } from '../boards/service.js';
import { type ProfileFacts, type WorkflowStep, type WorkflowTrigger, validateSteps } from './definition.js';
import { advanceRun, cancelRun, parseSteps, parseTrigger, runBoardTriggers, startManualRun } from './engine.js';

export interface WorkflowInput {
  name: string;
  description: string;
  isEnabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  maxConcurrentRuns: number;
}

/** Same checks as saving; Órbi uses them to validate a proposal before showing it. */
export async function validateWorkflow(workspaceId: string, input: Pick<WorkflowInput, 'steps' | 'trigger'>) {
  const profileIds = input.steps.flatMap((step) => (step.kind === 'agent' ? [step.profileId] : []));
  const profiles = await prisma.agentProfile.findMany({ where: { id: { in: profileIds }, workspaceId } });
  const facts: ProfileFacts[] = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    hasRepository: profile.projectIds.length > 0,
    deliversCode: profile.projectIds.length > 0 && profile.output === 'PULL_REQUEST',
    usesBoard: profile.tools.includes('board'),
  }));
  const problems = validateSteps(input.steps, facts);
  if (input.trigger.type === 'board_task' && !(await prisma.taskBoard.findUnique({ where: { workspaceId } }))) {
    problems.push('O gatilho "tarefa no quadro" precisa de um quadro vinculado ao workspace.');
  }
  if (problems.length > 0) throw new HttpError(422, problems.join(' '), problems);
}

function duplicateName(error: unknown) {
  return error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function toResponse(workflow: Workflow) {
  const [running, total] = await Promise.all([
    prisma.workflowRun.count({ where: { workflowId: workflow.id, status: 'RUNNING' } }),
    prisma.workflowRun.count({ where: { workflowId: workflow.id } }),
  ]);
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    description: workflow.description,
    isEnabled: workflow.isEnabled,
    trigger: parseTrigger(workflow),
    steps: parseSteps(workflow),
    maxConcurrentRuns: workflow.maxConcurrentRuns,
    lastCheckedAt: workflow.lastCheckedAt,
    statusMessage: workflow.statusMessage,
    runningRuns: running,
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
  try {
    const workflow = await prisma.workflow.create({
      data: {
        workspaceId,
        ...input,
        trigger: input.trigger as Prisma.InputJsonValue,
        steps: input.steps as unknown as Prisma.InputJsonValue,
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
  try {
    const workflow = await prisma.workflow.update({
      where: { id },
      data: {
        ...input,
        ...(input.trigger && { trigger: input.trigger as Prisma.InputJsonValue }),
        ...(input.steps && { steps: input.steps as unknown as Prisma.InputJsonValue }),
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
  const board = await prisma.taskBoard.findUnique({ where: { workspaceId: workflow.workspaceId } });
  if (board) await syncBoard(board).catch(() => undefined);
  await runBoardTriggers(workflow.workspaceId, log, workflow.id);
  return { runId: null };
}

// ---------------------------------------------------------------- runs

const runInclude = {
  workflow: { select: { name: true, steps: true } },
  steps: { orderBy: [{ stepIndex: 'asc' }, { attempt: 'asc' }] },
} satisfies Prisma.WorkflowRunInclude;

type RunWithDetails = Prisma.WorkflowRunGetPayload<{ include: typeof runInclude }>;

async function runResponse(run: RunWithDetails) {
  const agentIds = run.steps.flatMap((step) => (step.agentId ? [step.agentId] : []));
  const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, status: true, title: true } });
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
    steps: run.steps.map((step) => ({
      id: step.id,
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      lane: step.lane,
      attempt: step.attempt,
      status: step.status,
      agentId: step.agentId,
      agentStatus: agents.find((agent) => agent.id === step.agentId)?.status ?? null,
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
