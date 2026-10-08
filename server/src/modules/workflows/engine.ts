import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Prisma, Workflow, WorkflowRun, WorkflowStepRun } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import type { AgentResult } from '../agent-tools/service.js';
import { type AgentModel, cancelAgent, launchAgent, sendMessage } from '../agents/service.js';
import { boardContext } from '../boards/service.js';
import type { BoardItem, StatusMap } from '../boards/types.js';
import { getDeployment, startDeploy } from '../render/service.js';
import { getResourceUsage } from '../system/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { type AgentStep, type WorkflowStep, type WorkflowTrigger, fanOutIndex, laneFor, stepSchema, triggerSchema } from './definition.js';
import { pickTasks, taskPrompt } from './match.js';

/** Handoff stored on each finished step and read by the next ones. */
export interface StepOutput {
  agentId?: string;
  /** The agent delivers code (commit + PR/MR), so a deploy publishes its work. */
  deliversCode?: boolean;
  projectId?: string | null;
  prUrl?: string | null;
  branch?: string;
  status?: 'success' | 'failure';
  summary?: string;
  details?: string;
  createdTasks?: AgentResult['createdTasks'];
  deploymentId?: string;
  deployStatus?: string;
  serviceName?: string;
}

export function parseSteps(workflow: Pick<Workflow, 'steps'>): WorkflowStep[] {
  return stepSchema.array().parse(workflow.steps);
}

export function parseTrigger(workflow: Pick<Workflow, 'trigger'>): WorkflowTrigger {
  return triggerSchema.parse(workflow.trigger);
}

function errorText(error: unknown) {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message.slice(0, 500) : String(error);
}

// ---------------------------------------------------------------- guards

/** Why no new agent should start in the workspace now (Claude plan or Docker at the limit), or null. */
export async function workspaceBlocker(workspaceId: string): Promise<string | null> {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { agentAccount: true } });
  if (!settings?.agentAccount) return 'Parado: o workspace não tem conta Claude configurada.';

  const plan = settings.agentAccount.planUsage as PlanUsage | null;
  const session = plan?.windows.find((window) => window.key === 'five_hour');
  if (plan?.status === 'rejected') return 'Pausado: limite do plano Claude atingido.';
  if (session && session.percent >= config.workflowPlanLimitPercent) {
    return `Pausado: janela de 5 horas do Claude em ${Math.round(session.percent)}% (limite ${config.workflowPlanLimitPercent}%).`;
  }
  const usage = await getResourceUsage().catch(() => null);
  if (usage && usage.launchWarnings.length > 0) return `Aguardando: ${usage.launchWarnings.join(' ')}`;
  return null;
}

// ---------------------------------------------------------------- starting runs

function titleFrom(text: string) {
  return (text.trim().split('\n')[0] ?? '').slice(0, 120) || 'Execução';
}

export async function startManualRun(workflow: Workflow, message: string, log?: FastifyBaseLogger) {
  const run = await prisma.workflowRun.create({
    data: { workflowId: workflow.id, workspaceId: workflow.workspaceId, title: titleFrom(message), trigger: { message } },
  });
  await advanceRun(run.id, log);
  return run;
}

async function startBoardRun(workflow: Workflow, item: BoardItem, log?: FastifyBaseLogger) {
  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      title: item.title.slice(0, 120),
      trigger: { taskItemId: item.id, title: item.title },
      taskItemId: item.id,
    },
  });
  await advanceRun(run.id, log);
  return run;
}

/**
 * Board triggers: for each enabled workflow watching the board, starts a run per
 * matching task, up to its concurrent runs. A task that ever had an agent or a run is never picked again.
 */
export async function runBoardTriggers(workspaceId: string, log?: FastifyBaseLogger, onlyWorkflowId?: string) {
  const workflows = (
    await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true, ...(onlyWorkflowId && { id: onlyWorkflowId }) }, orderBy: { createdAt: 'asc' } })
  ).filter((workflow) => parseTrigger(workflow).type === 'board_task');
  if (workflows.length === 0) return;

  const report = (workflow: Workflow, statusMessage: string) =>
    prisma.workflow.update({ where: { id: workflow.id }, data: { statusMessage, lastCheckedAt: new Date() } });

  const blocker = await workspaceBlocker(workspaceId);
  if (blocker) {
    for (const workflow of workflows) await report(workflow, blocker);
    return;
  }

  const { board, snapshot, projectOf } = await boardContext(workspaceId);
  const statusMap = board.statusMap as StatusMap;
  const [agentTasks, runTasks] = await Promise.all([
    prisma.agent.findMany({ where: { workspaceId, taskItemId: { not: null } }, select: { taskItemId: true } }),
    prisma.workflowRun.findMany({ where: { workspaceId, taskItemId: { not: null } }, select: { taskItemId: true } }),
  ]);
  const taken = new Set([...agentTasks, ...runTasks].map((entry) => entry.taskItemId!));

  for (const workflow of workflows) {
    const trigger = parseTrigger(workflow) as Extract<WorkflowTrigger, { type: 'board_task' }>;
    const running = await prisma.workflowRun.count({ where: { workflowId: workflow.id, status: 'RUNNING' } });
    const slots = workflow.maxConcurrentRuns - running;
    if (slots <= 0) {
      await report(workflow, `Ocupado: ${running} execução(ões) em andamento.`);
      continue;
    }
    const columnId = trigger.columnId ?? statusMap.todo ?? null;
    const candidates = pickTasks(snapshot.items, snapshot.fields, { ...trigger, columnId }).filter(
      (item) => !taken.has(item.id) && projectOf(item) && item.columnId !== statusMap.blocked,
    );
    if (candidates.length === 0) {
      await report(workflow, columnId ? 'Vigiando: nenhuma tarefa nova.' : 'Parado: o quadro não tem coluna "A fazer" definida.');
      continue;
    }
    const started: string[] = [];
    for (const item of candidates.slice(0, slots)) {
      taken.add(item.id);
      await startBoardRun(workflow, item, log);
      started.push(`"${item.title}"`);
    }
    await report(workflow, `Iniciou para: ${started.join(', ')}.`);
  }
}

// ---------------------------------------------------------------- advancing runs

const advancing = new Set<string>();

type RunWithSteps = WorkflowRun & { workflow: Workflow; steps: WorkflowStepRun[] };

/** Latest attempt of a step in a lane. */
function latest(stepRuns: WorkflowStepRun[], stepId: string, lane: string) {
  return stepRuns
    .filter((entry) => entry.stepId === stepId && entry.lane === lane)
    .sort((a, b) => b.attempt - a.attempt)[0];
}

const outputOf = (stepRun: WorkflowStepRun | undefined) => (stepRun?.output ?? {}) as StepOutput;

/** Updates a running step from its agent or deployment. */
async function syncStep(stepRun: WorkflowStepRun) {
  const finish = (status: 'SUCCEEDED' | 'FAILED', output: StepOutput, error: string | null = null) =>
    prisma.workflowStepRun.update({
      where: { id: stepRun.id },
      data: { status, output: output as Prisma.InputJsonValue, error, finishedAt: new Date() },
    });

  if (stepRun.deploymentId) {
    const deployment = await getDeployment(stepRun.deploymentId).catch(() => null);
    if (!deployment) return finish('FAILED', {}, 'O deploy não existe mais.');
    if (!deployment.isFinished) return;
    const output = { deploymentId: deployment.id, deployStatus: deployment.statusLabel, serviceName: deployment.serviceName };
    return deployment.isSuccess ? finish('SUCCEEDED', output) : finish('FAILED', output, deployment.error ?? `Deploy terminou como "${deployment.statusLabel}".`);
  }

  if (!stepRun.agentId) return;
  const agent = await prisma.agent.findUnique({ where: { id: stepRun.agentId } });
  if (!agent) return finish('FAILED', {}, 'O agente deste passo foi excluído.');

  const result = (agent.result ?? {}) as AgentResult;
  const output: StepOutput = {
    agentId: agent.id,
    deliversCode: agent.output === 'PULL_REQUEST' && agent.projectId !== null,
    projectId: agent.projectId,
    prUrl: agent.prUrl,
    branch: agent.branch,
    status: result.status,
    summary: result.summary,
    details: result.details,
    createdTasks: result.createdTasks,
  };
  if (agent.status === 'COMPLETED') {
    return result.status === 'failure' ? finish('FAILED', output, result.summary ?? 'O agente reportou falha.') : finish('SUCCEEDED', output);
  }
  if (agent.status === 'FAILED' || agent.status === 'CANCELLED') {
    return finish('FAILED', output, agent.errorMessage ?? (agent.status === 'CANCELLED' ? 'Agente cancelado.' : 'Agente falhou.'));
  }
  // An automatic conclusion that failed (e.g. push refused) leaves the agent in review with an error.
  if (agent.status === 'READY_FOR_REVIEW' && agent.errorMessage && !agent.containerId) {
    return finish('FAILED', output, agent.errorMessage);
  }
}

function previousOutputText(name: string, output: StepOutput) {
  const lines = [`Resultado do passo anterior (${name}):`];
  if (output.summary) lines.push(output.summary);
  if (output.details) lines.push('', output.details);
  if (output.prUrl) lines.push('', `PR/MR: ${output.prUrl} (branch ${output.branch})`);
  if (output.createdTasks?.length) {
    lines.push('', 'Tarefas criadas:', ...output.createdTasks.map((task) => `- ${task.title}${task.ref ? ` (${task.ref})` : ''}`));
  }
  return lines.join('\n');
}

/** Starts a step in a lane; problems become a failed step instead of an exception. */
async function startStep(run: RunWithSteps, steps: WorkflowStep[], index: number, lane: string, attempt: number) {
  const step = steps[index]!;
  const fail = (error: string) =>
    prisma.workflowStepRun.create({
      data: { runId: run.id, stepId: step.id, stepIndex: index, lane, attempt, status: 'FAILED', error, finishedAt: new Date() },
    });

  // Earlier steps of this lane, nearest first.
  const earlier = steps
    .slice(0, index)
    .map((entry, position) => ({ step: entry, run: latest(run.steps, entry.id, laneFor(steps, position, lane)) }))
    .reverse();

  if (step.kind === 'deploy') {
    // The nearest earlier agent that delivers code (testers and planners only report); it may have changed nothing.
    const code = earlier.find((entry) => outputOf(entry.run).deliversCode);
    if (!code) return fail('Nenhum passo anterior tem um agente que entrega código para publicar.');
    if (!outputOf(code.run).prUrl) {
      return prisma.workflowStepRun.create({
        data: {
          runId: run.id,
          stepId: step.id,
          stepIndex: index,
          lane,
          attempt,
          status: 'SUCCEEDED',
          output: { summary: 'Nada para publicar: o passo anterior terminou sem alterações.' },
          finishedAt: new Date(),
        },
      });
    }
    try {
      const deployment = await startDeploy({
        workspaceId: run.workspaceId,
        projectId: outputOf(code.run).projectId!,
        environment: step.environment,
        agentId: outputOf(code.run).agentId,
      });
      return prisma.workflowStepRun.create({
        data: { runId: run.id, stepId: step.id, stepIndex: index, lane, attempt, deploymentId: deployment.id },
      });
    } catch (error) {
      return fail(errorText(error));
    }
  }

  const profile = await prisma.agentProfile.findUnique({ where: { id: step.profileId } });
  if (!profile) return fail('O agente do workspace deste passo foi excluído.');

  const trigger = run.trigger as { message?: string; taskItemId?: string };
  const previous = earlier[0];
  const isTaskLane = lane !== 'main';
  const fanOut = fanOutIndex(steps);

  let task: BoardItem | undefined;
  let projectId: string | null | undefined;
  const taskItemId = isTaskLane ? lane : index === 0 ? trigger.taskItemId : undefined;
  if (taskItemId) {
    const context = await boardContext(run.workspaceId).catch(() => null);
    task = context?.snapshot.items.find((item) => item.id === taskItemId);
    if (task) projectId = context!.projectOf(task);
  }

  // A task from a repository the agent does not work on cannot be handled by this step.
  if (task && projectId && profile.projectIds.length > 0 && !profile.projectIds.includes(projectId)) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    return fail(`A tarefa "${task.title}" é do projeto ${project?.name ?? '?'}, e o agente "${profile.name}" não trabalha nele.`);
  }

  let sourceAgentId: string | undefined;
  if (step.continueFromPrevious) {
    const output = outputOf(previous?.run);
    if (!output.agentId) return fail('O passo anterior não tem agente para continuar.');
    sourceAgentId = output.agentId;
    projectId = output.projectId;
  } else if (projectId === undefined && profile.projectIds.length > 1) {
    // Several projects: follow the project the chain is already working on.
    const chainProject = earlier.map((entry) => outputOf(entry.run).projectId).find((id) => id && profile.projectIds.includes(id));
    projectId = chainProject ?? undefined;
  }

  const prompt = [
    `Workflow "${run.workflow.name}" — passo ${index + 1} de ${steps.length}: ${step.name}.`,
    '',
    task ? taskPrompt(task, '') : index === 0 ? (trigger.message ?? run.title) : `Pedido original: ${trigger.message ?? run.title}`,
    ...(previous?.run ? ['', previousOutputText(previous.step.name, outputOf(previous.run))] : []),
    ...(step.instructions.trim() ? ['', 'Instruções deste passo:', step.instructions.trim()] : []),
  ].join('\n');

  try {
    const agent = await launchAgent({
      profileId: profile.id,
      projectId: projectId ?? null,
      prompt,
      title: `${step.name}: ${task?.title ?? run.title}`.slice(0, 120),
      model: profile.model as AgentModel,
      workflowRunId: run.id,
      autoConclude: true,
      confirmHighUsage: true,
      // Only the step that picks the task moves its card (to "in progress", then review on the PR).
      ...(taskItemId && (index === 0 || index === fanOut) && { taskItemId }),
      ...(sourceAgentId && { sourceAgentId }),
    });
    return prisma.workflowStepRun.create({
      data: { runId: run.id, stepId: step.id, stepIndex: index, lane, attempt, agentId: agent.id },
    });
  } catch (error) {
    return fail(errorText(error));
  }
}

/**
 * A failed step with "on failure, send back": the report goes to the earlier step's agent, which keeps
 * working on the same copy and PR; the steps after it run again when it finishes.
 */
async function sendBack(run: RunWithSteps, steps: WorkflowStep[], failed: WorkflowStepRun) {
  const index = steps.findIndex((step) => step.id === failed.stepId);
  const step = steps[index];
  if (step?.kind !== 'agent' || !step.onFailure) return false;
  const targetIndex = steps.findIndex((entry) => entry.id === step.onFailure!.retryStepId);
  const targetLane = laneFor(steps, targetIndex, failed.lane);
  const target = latest(run.steps, step.onFailure.retryStepId, targetLane);
  if (!target?.agentId || target.attempt >= step.onFailure.maxAttempts) return false;

  const output = outputOf(failed);
  const report = [
    `O passo "${step.name}" encontrou problemas no seu trabalho (tentativa ${target.attempt} de ${step.onFailure.maxAttempts}):`,
    output.summary ?? failed.error ?? '',
    output.details ?? '',
    '',
    'Corrija na mesma cópia e termine novamente; o Studio envia as novas alterações para o mesmo PR/MR.',
  ].join('\n');
  await sendMessage(target.agentId, report.trim());

  // History stays: the failed step and everything after the target are marked as sent back.
  const replaced = steps
    .slice(targetIndex)
    .map((entry, offset) => latest(run.steps, entry.id, laneFor(steps, targetIndex + offset, failed.lane)))
    .filter((entry): entry is WorkflowStepRun => Boolean(entry) && entry!.status !== 'RETRIED');
  await prisma.workflowStepRun.updateMany({
    where: { id: { in: replaced.map((entry) => entry.id) } },
    data: { status: 'RETRIED', finishedAt: new Date() },
  });
  await prisma.workflowStepRun.create({
    data: {
      runId: run.id,
      stepId: target.stepId,
      stepIndex: target.stepIndex,
      lane: target.lane,
      attempt: target.attempt + 1,
      agentId: target.agentId,
    },
  });
  return true;
}

/** Moves a run forward: syncs running steps, handles send-backs, starts what is ready, and finishes the run. */
export async function advanceRun(runId: string, log?: FastifyBaseLogger) {
  if (advancing.has(runId)) return;
  advancing.add(runId);
  try {
    const load = () => prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { workflow: true, steps: true } });
    let run: RunWithSteps = await load();
    if (run.status !== 'RUNNING') return;
    const steps = parseSteps(run.workflow);

    for (const stepRun of run.steps.filter((entry) => entry.status === 'RUNNING')) await syncStep(stepRun);
    run = await load();

    for (const stepRun of run.steps.filter((entry) => entry.status === 'FAILED')) {
      const isLatest = latest(run.steps, stepRun.stepId, stepRun.lane)?.id === stepRun.id;
      if (isLatest && (await sendBack(run, steps, stepRun))) run = await load();
    }

    const blocker = await workspaceBlocker(run.workspaceId);
    const fanOut = fanOutIndex(steps);
    const lastIndex = steps.length - 1;
    // Set inside walk(); typed as boolean so TypeScript does not narrow them to their initial value.
    let pending: boolean = false;
    let failed: boolean = false;

    /** Walks a lane from `from`; starts the next step when the one before it succeeded. Returns whether the lane ended. */
    const walk = async (lane: string, from: number, to: number) => {
      for (let index = from; index <= to; index++) {
        const stepLane = laneFor(steps, index, lane);
        const current = latest(run.steps, steps[index]!.id, stepLane);
        if (current && current.status === 'SUCCEEDED') continue;
        if (current && current.status === 'RUNNING') {
          pending = true;
          return;
        }
        if (current && (current.status === 'FAILED' || current.status === 'CANCELLED')) {
          failed = true;
          return;
        }
        // Not started yet (or sent back): start it, unless the workspace is at its limits.
        if (blocker) {
          pending = true;
          return;
        }
        await startStep(run, steps, index, stepLane, (current?.attempt ?? 0) + 1);
        run = await load();
        pending = true;
        return;
      }
    };

    if (fanOut === -1) {
      await walk('main', 0, lastIndex);
    } else {
      await walk('main', 0, fanOut - 1);
      // After the fan-out, every task created by the previous step gets its own lane, a few at a time.
      if (!pending && !failed) {
        const tasks = outputOf(latest(run.steps, steps[fanOut - 1]!.id, 'main')).createdTasks ?? [];
        const maxParallel = (steps[fanOut] as AgentStep).maxParallel;
        const laneEnded = (lane: string) => {
          const last = latest(run.steps, steps[lastIndex]!.id, lane);
          if (last?.status === 'SUCCEEDED') return true;
          return steps.slice(fanOut).some((step) => {
            const current = latest(run.steps, step.id, lane);
            return current?.status === 'FAILED' || current?.status === 'CANCELLED';
          });
        };
        let active = tasks.filter((task) => latest(run.steps, steps[fanOut]!.id, task.id) && !laneEnded(task.id)).length;
        for (const task of tasks) {
          const started = Boolean(latest(run.steps, steps[fanOut]!.id, task.id));
          if (!started) {
            if (active >= maxParallel) {
              pending = true;
              continue;
            }
            active++;
          }
          await walk(task.id, fanOut, lastIndex);
        }
      }
    }

    if (!pending) {
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: failed ? 'FAILED' : 'COMPLETED', finishedAt: new Date(), error: failed ? 'Um ou mais passos falharam.' : null },
      });
      log?.info({ runId, failed }, 'Workflow run finished');
    }
  } catch (err) {
    log?.error({ runId, err }, 'Workflow run could not advance');
  } finally {
    advancing.delete(runId);
  }
}

/** Advances every running run; called by the scheduler, so runs resume after a restart. */
export async function advanceAllRuns(log: FastifyBaseLogger) {
  const runs = await prisma.workflowRun.findMany({ where: { status: 'RUNNING' }, select: { id: true } });
  for (const run of runs) await advanceRun(run.id, log);
}

export async function cancelRun(runId: string) {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { steps: true } });
  if (!run) throw new HttpError(404, 'Execução não encontrada.');
  if (run.status !== 'RUNNING') throw new HttpError(409, 'A execução já terminou.');
  for (const step of run.steps.filter((entry) => entry.status === 'RUNNING' && entry.agentId)) {
    await cancelAgent(step.agentId!).catch(() => undefined);
  }
  await prisma.workflowStepRun.updateMany({ where: { runId, status: 'RUNNING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
}
