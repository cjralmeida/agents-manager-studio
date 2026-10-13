import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Prisma, Workflow, WorkflowRun, WorkflowStepRun } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import type { AgentResult } from '../agent-tools/service.js';
import { type AgentModel, PREPARATION_INTERRUPTED, cancelAgent, launchAgent, mergeBaseIntoCopy, sendMessage } from '../agents/service.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { type TaskPullRequest, findTaskPullRequest } from '../agents/task-pull-request.js';
import { fastForwardFrom } from '../agents/workdir.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { secrets } from '../../lib/secrets.js';
import { dependenciesDelivered } from '../boards/dependencies.js';
import { boardContext, editItem, moveAgentTask } from '../boards/service.js';
import type { BoardItem, StatusMap } from '../boards/types.js';
import { getDeployment, startDeploy } from '../render/service.js';
import { getResourceUsage } from '../system/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { planBlockedUntil } from '../plan-limit/limit.js';
import { type AgentStep, type WorkflowStep, type WorkflowTrigger, fanOutIndex, laneFor, stepSchema, triggerSchema } from './definition.js';
import { type ReadyFeature, awaitingDecision, decisionPrompt, featurePrompt, featuresReady, pickTasks, taskPrompt } from './match.js';

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
  mergeConflict?: boolean;
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
  // A usage report from before the window reset is stale: the limit no longer holds once its reset has passed.
  const session = plan?.windows.find((window) => window.key === 'five_hour' && (!window.resetsAt || new Date(window.resetsAt) > new Date()));
  const blockedUntil = planBlockedUntil(plan);
  if (blockedUntil) return `Pausado: limite do plano Claude atingido; volta em ${blockedUntil.toLocaleString('pt-BR', { timeZone: process.env.TZ || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`;
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

async function startFeatureRun(workflow: Workflow, feature: ReadyFeature, log?: FastifyBaseLogger) {
  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      title: `${feature.featureId} — teste em homologação`,
      trigger: {
        featureId: feature.featureId,
        signature: feature.signature,
        taskItemIds: feature.tasks.map((task) => task.id),
        message: featurePrompt(feature),
      },
    },
  });
  await advanceRun(run.id, log);
  return run;
}

/** Agent states in which a task is still being worked on. */
/** Edits within this time after a decision run ended are the run's own (e.g. the board's update time lagging). */
const DECISION_EDIT_MARGIN_MS = 3 * 60_000;

const ACTIVE_AGENT = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING'] as const;

export type BoardTaskState = Awaited<ReturnType<typeof boardTaskState>>;

/**
 * The board of the workspace and which tasks are taken: an agent works on it, its run is going, or its last run did
 * not finish well and nobody changed the task since.
 */
export async function boardTaskState(workspaceId: string) {
  const { snapshot, projectOf, statusMap } = await boardContext(workspaceId);
  const delivered = dependenciesDelivered(snapshot.items, statusMap);
  const [activeAgents, runs] = await Promise.all([
    prisma.agent.findMany({ where: { workspaceId, taskItemId: { not: null }, status: { in: [...ACTIVE_AGENT] } }, select: { taskItemId: true } }),
    prisma.workflowRun.findMany({
      where: { workspaceId, taskItemId: { not: null } },
      select: { taskItemId: true, status: true, finishedAt: true },
      orderBy: { startedAt: 'desc' },
    }),
  ]);
  const lastRun = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!lastRun.has(run.taskItemId!)) lastRun.set(run.taskItemId!, run);
  const taken = new Set(activeAgents.map((agent) => agent.taskItemId!));
  for (const item of snapshot.items) {
    const run = lastRun.get(item.id);
    if (!run) continue;
    const changedSince = run.finishedAt !== null && new Date(item.updatedAt).getTime() > run.finishedAt.getTime();
    if (run.status === 'RUNNING' || (run.status !== 'COMPLETED' && !changedSince)) taken.add(item.id);
  }
  return { snapshot, projectOf, statusMap, delivered, taken, lastRun };
}

/**
 * The tasks a "tarefa no quadro" workflow can start now (ready) and the ones in its column still waiting for their
 * "Depende de:" tasks (waiting). A task sent back after its run (e.g. with a homologation report) keeps the assignee
 * the run gave it.
 */
export function boardTaskQueue(trigger: Extract<WorkflowTrigger, { type: 'board_task' }>, state: BoardTaskState) {
  const { snapshot, projectOf, statusMap, delivered, taken, lastRun } = state;
  const columnId = trigger.columnId ?? statusMap.todo ?? null;
  const matching = pickTasks(snapshot.items, snapshot.fields, { ...trigger, columnId, onlyUnassigned: false }).filter(
    (item) =>
      !taken.has(item.id) &&
      projectOf(item) &&
      item.columnId !== statusMap.blocked &&
      (!trigger.onlyUnassigned || item.assignees.length === 0 || lastRun.has(item.id)),
  );
  return { columnId, ready: matching.filter((item) => delivered(item)), waiting: matching.filter((item) => !delivered(item)) };
}

/**
 * Board triggers: for each enabled workflow watching the board, starts a run per matching task (or per feature
 * ready in homologation), up to its concurrent runs. A task is picked again only when it comes back to the watched
 * column after its last run finished (e.g. sent back with a homologation report); after a failed run, only once
 * someone changed the task.
 */
export async function runBoardTriggers(workspaceId: string, log?: FastifyBaseLogger, onlyWorkflowId?: string) {
  const workflows = (
    await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true, ...(onlyWorkflowId && { id: onlyWorkflowId }) }, orderBy: { createdAt: 'asc' } })
  ).filter((workflow) => parseTrigger(workflow).type !== 'manual');
  if (workflows.length === 0) return;

  const report = (workflow: Workflow, statusMessage: string) =>
    prisma.workflow.update({ where: { id: workflow.id }, data: { statusMessage, lastCheckedAt: new Date() } });

  const blocker = await workspaceBlocker(workspaceId);
  if (blocker) {
    for (const workflow of workflows) await report(workflow, blocker);
    return;
  }

  const state = await boardTaskState(workspaceId);
  const { snapshot, projectOf, statusMap, taken, lastRun } = state;

  for (const workflow of workflows) {
    const trigger = parseTrigger(workflow);
    const running = await prisma.workflowRun.count({ where: { workflowId: workflow.id, status: 'RUNNING' } });
    const slots = workflow.maxConcurrentRuns - running;
    if (slots <= 0) {
      await report(workflow, `Ocupado: ${running} execução(ões) em andamento.`);
      continue;
    }

    if (trigger.type === 'feature_in_homologation') {
      if (!statusMap.homologation) {
        await report(workflow, 'Parado: o quadro não tem coluna de homologação definida.');
        continue;
      }
      const ready = featuresReady(snapshot.items, {
        homologationColumnId: statusMap.homologation,
        doneColumnId: statusMap.done ?? null,
        repositories: trigger.repositories,
      });
      const previous = await prisma.workflowRun.findMany({
        where: { workflowId: workflow.id },
        select: { status: true, trigger: true },
        orderBy: { startedAt: 'desc' },
        take: 300,
      });
      const lastOf = (featureId: string) => previous.find((run) => (run.trigger as { featureId?: string }).featureId === featureId);
      // A feature is tested again only after something changed (e.g. a task came back with a report).
      const candidates = ready.filter((feature) => {
        const last = lastOf(feature.featureId);
        return !last || (last.status !== 'RUNNING' && (last.trigger as { signature?: string }).signature !== feature.signature);
      });
      if (candidates.length === 0) {
        await report(workflow, 'Vigiando: nenhuma funcionalidade completa nova em homologação.');
        continue;
      }
      for (const feature of candidates.slice(0, slots)) await startFeatureRun(workflow, feature, log);
      await report(workflow, `Iniciou para: ${candidates.slice(0, slots).map((feature) => feature.featureId).join(', ')}.`);
      continue;
    }
    if (trigger.type === 'task_awaiting_decision') {
      if (!statusMap.blocked) {
        await report(workflow, 'Parado: o quadro não tem coluna "Aguardando aprovação" definida.');
        continue;
      }
      const candidates = awaitingDecision(snapshot.items, statusMap.blocked, trigger.repositories).filter((item) => {
        if (taken.has(item.id) || !projectOf(item)) return false;
        // Studied once; again only after someone changed the task (a margin covers the agent's own last edit).
        const last = lastRun.get(item.id);
        if (!last) return true;
        if (last.status === 'RUNNING' || !last.finishedAt) return false;
        return new Date(item.updatedAt).getTime() > last.finishedAt.getTime() + DECISION_EDIT_MARGIN_MS;
      });
      if (candidates.length === 0) {
        await report(workflow, 'Vigiando: nenhuma tarefa nova aguardando decisão.');
        continue;
      }
      const started: string[] = [];
      for (const item of candidates.slice(0, slots)) {
        taken.add(item.id);
        await startBoardRun(workflow, item, log);
        started.push(`"${item.title}"`);
      }
      await report(workflow, `Iniciou para: ${started.join(', ')}.`);
      continue;
    }
    if (trigger.type !== 'board_task') continue;

    const { ready: candidates, columnId } = boardTaskQueue(trigger, state);
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

/** The task a lane works on goes to the done column once the lane's last step succeeds (e.g. tests in homologation). */
async function completeTask(run: RunWithSteps, lane: string) {
  const trigger = run.trigger as { taskItemId?: string };
  const taskItemId = lane !== 'main' ? lane : (trigger.taskItemId ?? null);
  const workflowTrigger = parseTrigger(run.workflow);
  // A decision run leaves the card where the agent and the user put it.
  if (workflowTrigger.type === 'task_awaiting_decision') return;
  const role = workflowTrigger.type === 'board_task' ? workflowTrigger.moveWhenDone : 'done';
  await moveAgentTask({ workspaceId: run.workspaceId, taskItemId }, role);
}

const MAX_PREPARE_ATTEMPTS = 3;

/** Whether the step's agent failed while its copy was being prepared, before doing any work. */
async function failedBeforeCopy(stepRun: WorkflowStepRun) {
  if (stepRun.error === PREPARATION_INTERRUPTED) return true;
  if (!stepRun.agentId) return false;
  const agent = await prisma.agent.findUnique({ where: { id: stepRun.agentId }, select: { status: true, baseCommit: true } });
  return agent?.status === 'FAILED' && agent.baseCommit === null;
}

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
    // An agent without a repository may have created the project the next steps work on (e.g. a new game).
    projectId: agent.projectId ?? result.projectId ?? null,
    prUrl: agent.prUrl,
    branch: agent.branch,
    status: result.status,
    summary: result.summary,
    details: result.details,
    createdTasks: result.createdTasks,
    mergeConflict: result.mergeConflict,
  };
  if (agent.status === 'COMPLETED') {
    return result.status === 'failure' ? finish('FAILED', output, result.summary ?? 'O agente reportou falha.') : finish('SUCCEEDED', output);
  }
  if (agent.status === 'FAILED' || agent.status === 'CANCELLED') {
    return finish('FAILED', output, agent.errorMessage ?? (agent.status === 'CANCELLED' ? 'Agente cancelado.' : 'Agente falhou.'));
  }
  // An automatic conclusion that failed (e.g. push refused) leaves the agent in review with an error.
  // An agent waiting for the plan limit to reset is still on its step: the Studio resumes it.
  if (agent.status === 'READY_FOR_REVIEW' && agent.errorMessage && !agent.containerId && !agent.limitResumeAt) {
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
  const decision = parseTrigger(run.workflow).type === 'task_awaiting_decision';

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

  let pullRequest: TaskPullRequest | null = null;
  if (step.fromTaskPullRequest) {
    if (!task || !projectId) return fail('"Publicar o PR/MR da tarefa" precisa de uma tarefa do quadro num repositório do workspace.');
    try {
      pullRequest = await pullRequestOfTask(run.workspaceId, projectId, task);
    } catch (error) {
      return fail(errorText(error));
    }
    if (!pullRequest) return fail(`Nenhum PR/MR aberto cita a tarefa "${task.title}". Peça para citar a tarefa na descrição (ex.: "Closes #${task.number}").`);
    // Work done outside the Studio is only published when it targets the project's base branch (never "master" or "hom").
    const { baseBranch } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { baseBranch: true } });
    if (baseBranch && pullRequest.baseBranch !== baseBranch) {
      const notice = [
        `## Aviso de publicação — ${new Date().toISOString().slice(0, 10)}`,
        '',
        `O PR/MR ${pullRequest.url} aponta para \`${pullRequest.baseBranch}\`, mas este projeto só publica a partir de \`${baseBranch}\`. Nada foi mesclado.`,
        `Abra (ou redirecione) o PR/MR para \`${baseBranch}\` e mova a tarefa de novo para a coluna de validação.`,
      ].join('\n');
      await editItem(run.workspaceId, task.id, { body: `${task.body.trimEnd()}\n\n${notice}` }).catch(() => undefined);
      await moveAgentTask({ workspaceId: run.workspaceId, taskItemId: task.id }, 'todo');
      return fail(`O PR/MR da tarefa aponta para "${pullRequest.baseBranch}"; o projeto só aceita "${baseBranch}". A tarefa voltou para "A fazer" com o aviso.`);
    }
  }

  let sourceAgentId: string | undefined;
  if (step.continueFromPrevious) {
    const output = outputOf(previous?.run);
    if (!output.agentId) return fail('O passo anterior não tem agente para continuar.');
    sourceAgentId = output.agentId;
    projectId = output.projectId;
  } else if (projectId === undefined && profile.anyProject) {
    // Works on the project the chain is on: the latest one an earlier step worked on or created.
    projectId = earlier.map((entry) => outputOf(entry.run).projectId).find(Boolean) ?? undefined;
    if (!projectId) return fail(`Nenhum passo anterior criou ou escolheu o projeto em que o agente "${profile.name}" vai trabalhar.`);
  } else if (projectId === undefined && profile.projectIds.length > 1) {
    // Several projects: follow the project the chain is already working on.
    const chainProject = earlier.map((entry) => outputOf(entry.run).projectId).find((id) => id && profile.projectIds.includes(id));
    projectId = chainProject ?? undefined;
  }

  const prompt = [
    `Workflow "${run.workflow.name}" — passo ${index + 1} de ${steps.length}: ${step.name}.`,
    '',
    task ? (decision ? decisionPrompt(task) : taskPrompt(task, '')) : index === 0 ? (trigger.message ?? run.title) : `Pedido original: ${trigger.message ?? run.title}`,
    ...(previous?.run ? ['', previousOutputText(previous.step.name, outputOf(previous.run))] : []),
    ...(step.instructions.trim() ? ['', 'Instruções deste passo:', step.instructions.trim()] : []),
  ].join('\n');

  try {
    const agent = await launchAgent({
      profileId: profile.id,
      projectId: projectId ?? null,
      prompt,
      title: `${step.name}: ${task?.title ?? run.title}`.slice(0, 120),
      model: (step.model ?? profile.model) as AgentModel,
      workflowRunId: run.id,
      autoConclude: true,
      confirmHighUsage: true,
      // Only the step that picks the task moves its card (to "in progress", then review on the PR).
      // Work done outside the Studio keeps its card where it was left until the run ends.
      // A task awaiting a decision stays put: the agent only reads it and moves it after deciding with the user.
      ...(taskItemId && !pullRequest && !decision && (index === 0 || index === fanOut) && { taskItemId }),
      ...(sourceAgentId && { sourceAgentId }),
      ...(pullRequest && { pullRequest: { url: pullRequest.url, branch: pullRequest.branch, baseBranch: pullRequest.baseBranch } }),
    });
    return prisma.workflowStepRun.create({
      data: { runId: run.id, stepId: step.id, stepIndex: index, lane, attempt, agentId: agent.id },
    });
  } catch (error) {
    return fail(errorText(error));
  }
}

/** The open PR/MR made outside the Studio for a task, found with the workspace account of the project's host. */
async function pullRequestOfTask(workspaceId: string, projectId: string, task: BoardItem) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote || !task.number) throw new HttpError(422, 'A tarefa precisa ser uma issue do repositório do projeto para achar o PR/MR.');
  const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
  return findTaskPullRequest({
    provider: account.provider as 'GITHUB' | 'GITLAB',
    remote,
    token: secrets.decrypt(account.tokenEncrypted),
    issueNumber: task.number,
    knownNumbers: task.pullRequests.map((pr) => pr.number),
  });
}

/** Extra rounds a send-back gets when the work was approved and only its PR/MR conflicts with the base. */
const CONFLICT_EXTRA_ATTEMPTS = 2;

/**
 * A failed step with "on failure, send back": the report goes to the earlier step's agent, which keeps
 * working on the same copy and PR; the steps after it run again when it finishes. When the work was approved but the
 * PR/MR conflicts with the base, the Studio merges the base into that copy first and asks only for the conflicts.
 */
async function sendBack(run: RunWithSteps, steps: WorkflowStep[], failed: WorkflowStepRun) {
  const index = steps.findIndex((step) => step.id === failed.stepId);
  const step = steps[index];
  if (step?.kind !== 'agent' || !step.onFailure) return false;
  const targetIndex = steps.findIndex((entry) => entry.id === step.onFailure!.retryStepId);
  const targetLane = laneFor(steps, targetIndex, failed.lane);
  const target = latest(run.steps, step.onFailure.retryStepId, targetLane);
  const output = outputOf(failed);
  const limit = step.onFailure.maxAttempts + (output.mergeConflict ? CONFLICT_EXTRA_ATTEMPTS : 0);
  if (!target?.agentId || target.attempt >= limit) return false;

  const synced = await syncReviewerCommits(target.agentId, failed.agentId);
  const report = output.mergeConflict
    ? await conflictReport(target.agentId, step.name, synced)
    : [
        `O passo "${step.name}" encontrou problemas no seu trabalho (tentativa ${target.attempt} de ${step.onFailure.maxAttempts}):`,
        output.summary ?? failed.error ?? '',
        output.details ?? '',
        ...(synced ? ['', synced] : []),
        '',
        'Corrija na mesma cópia e termine novamente; o Studio envia as novas alterações para o mesmo PR/MR.',
      ].join('\n');
  if (!report) return false;
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

/**
 * The message for an approved PR/MR that conflicts with the base: the base is merged into the agent's copy and the
 * agent resolves what git could not. Null when even that failed (the run then fails as before).
 */
async function conflictReport(agentId: string, stepName: string, synced: string | null) {
  try {
    const conflicts = await mergeBaseIntoCopy(agentId);
    const intro = `O passo "${stepName}" aprovou o seu trabalho, mas o PR/MR não pôde ser mesclado: outras tarefas foram entregues na branch de destino enquanto isso e mexeram nos mesmos arquivos.`;
    const done = 'Depois, termine; o Studio envia para o mesmo PR/MR e o passo de teste roda de novo sobre o código com o merge.';
    const body =
      conflicts.length > 0
        ? [
            'O Studio já trouxe a versão mais recente da branch de destino para a sua cópia (merge em andamento). Ficaram com conflito:',
            ...conflicts.map((file) => `- ${file}`),
            '',
            'Resolva cada conflito mantendo as duas mudanças: o que veio da branch de destino já foi entregue e testado por outras tarefas; não descarte nada dela sem motivo. Tire todos os marcadores (<<<<<<<, =======, >>>>>>>), não rode "git merge --abort" nem faça commit, rode o build e os testes e corrija o que quebrar com a junção.',
          ]
        : [
            'O Studio trouxe a versão mais recente da branch de destino para a sua cópia e o git juntou tudo sem conflito de texto. Rode o build e os testes e corrija o que quebrar com a junção (ex.: uma função renomeada do outro lado).',
          ];
    return [intro, '', ...body, ...(synced ? ['', synced] : []), '', done].join('\n');
  } catch {
    return null;
  }
}

/**
 * A reviewer that continued the target's copy works on the same branch; its commits (e.g. failing adversarial tests)
 * are brought into the target's copy so it fixes the code against them. Returns a line for the report, if any.
 */
async function syncReviewerCommits(targetAgentId: string, reviewerAgentId: string | null) {
  if (!reviewerAgentId) return null;
  const [target, reviewer] = await Promise.all([
    prisma.agent.findUnique({ where: { id: targetAgentId } }),
    prisma.agent.findUnique({ where: { id: reviewerAgentId } }),
  ]);
  if (!target || !reviewer || reviewer.branch !== target.branch || reviewer.projectId !== target.projectId || !target.projectId) return null;
  try {
    await fastForwardFrom({ workdir: target.workdir, fromWorkdir: reviewer.workdir, branch: target.branch });
    return `Os commits do passo de revisão (testes e ajustes) já estão na sua cópia (branch ${target.branch}): rode a suíte e corrija o código até tudo passar, sem alterar esses testes.`;
  } catch (error) {
    return `Não foi possível trazer os commits do passo de revisão para a sua cópia (${errorText(error)}); peça a lista de testes no relatório acima.`;
  }
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

    for (const stepRun of run.steps.filter((entry) => entry.status === 'RUNNING')) {
      const updated = await syncStep(stepRun);
      if (updated?.status === 'SUCCEEDED' && updated.stepIndex === steps.length - 1) await completeTask(run, updated.lane);
    }
    run = await load();

    for (const stepRun of run.steps.filter((entry) => entry.status === 'FAILED')) {
      const isLatest = latest(run.steps, stepRun.stepId, stepRun.lane)?.id === stepRun.id;
      if (!isLatest) continue;
      // The agent failed before it even had its copy (clone timed out on a slow disk, Studio restarted mid-way): not a
      // problem of the work, so the step simply starts again, a few times.
      if (stepRun.attempt < MAX_PREPARE_ATTEMPTS && (await failedBeforeCopy(stepRun))) {
        await prisma.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'RETRIED' } });
        run = await load();
        continue;
      }
      if (await sendBack(run, steps, stepRun)) run = await load();
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
