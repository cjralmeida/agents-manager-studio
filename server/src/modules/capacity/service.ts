import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Prisma, Workflow } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import type { BoardItem } from '../boards/types.js';
import { logActivity } from '../orbi/activity.js';
import { notifyPilot } from '../orbi/pilot.js';
import type { PlanUsage } from '../usage/calc.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import type { WorkflowStep } from '../workflows/definition.js';
import { type BoardTaskState, boardTaskQueue, boardTaskState, parseSteps, parseTrigger } from '../workflows/engine.js';
import { updateWorkflow } from '../workflows/service.js';
import { getResourceUsage } from '../system/service.js';
import { type CapacitySignal, type MachineState, type PlanState, type StepLoad, capacitySignals, signalsSignature } from './signals.js';

/**
 * Gestor de Capacidade: every few minutes, plain rules look at each step of each workflow (agents busy, queue, ready
 * tasks), the computer and the Claude plan. When the signals change, Órbi's pilot gets them and adjusts the agents of
 * each step; with the pilot off, they wait as a suggestion the user applies on the Órbi page or the Workflows tab.
 */

const TICK_MS = 3 * 60_000;
/** Least time between two changes raised for the same workspace, so the effect of one can be seen. */
const COOLDOWN_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const ref = (item: BoardItem) => (item.repository && item.number ? `${item.repository}#${item.number}` : item.id);

async function planState(workspaceId: string): Promise<PlanState> {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { agentAccount: true } });
  const plan = settings?.agentAccount?.planUsage as PlanUsage | null | undefined;
  const percent = (key: string) => plan?.windows.find((window) => window.key === key)?.percent ?? null;
  return { sessionPercent: percent('five_hour'), weekPercent: percent('seven_day'), limitPercent: config.workflowPlanLimitPercent };
}

/** The computer the agents run on: the Windows numbers when the helper measures them, else the Docker VM. */
async function machineState(): Promise<MachineState | null> {
  const usage = await getResourceUsage().catch(() => null);
  if (!usage) return null;
  const limits = { memoryLimit: config.launchMemoryPercent, cpuLimit: config.launchCpuPercent, minFreeDiskGb: config.minFreeDiskGb };
  if (usage.host) {
    const agentsDisk = usage.host.disks.find((disk) => disk.agents);
    return {
      ...limits,
      memoryPercent: usage.host.memoryPercent,
      cpuPercent: usage.host.cpuPercent,
      freeDiskGb: agentsDisk ? agentsDisk.free / 1024 ** 3 : null,
      source: 'host',
    };
  }
  return { ...limits, memoryPercent: usage.totals.memoryPercent, cpuPercent: usage.totals.cpuPercent, freeDiskGb: null, source: 'docker' };
}

/**
 * A step with one resource stays at one agent: a deploy, the agent that publishes to homologation (one HOM), and the
 * tests in homologation (a fragile shared environment).
 */
async function singleResourceSteps(workflow: Workflow, steps: WorkflowStep[]) {
  const trigger = parseTrigger(workflow);
  if (trigger.type === 'feature_in_homologation' || trigger.type === 'frontend_in_homologation') return new Set(steps.map((step) => step.id));
  const profileIds = steps.flatMap((step) => (step.kind === 'agent' ? [step.profileId] : []));
  const publishers = await prisma.agentProfile.findMany({ where: { id: { in: profileIds }, tools: { has: 'render' } }, select: { id: true } });
  return new Set(steps.filter((step) => step.kind === 'deploy' || publishers.some((profile) => profile.id === step.profileId)).map((step) => step.id));
}

/** Every step of the workspace's enabled workflows that take tasks by themselves, with its load. */
async function stepLoads(workspaceId: string, state: BoardTaskState): Promise<StepLoad[]> {
  const workflows = (await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true }, orderBy: { createdAt: 'asc' } })).filter(
    (workflow) => parseTrigger(workflow).type !== 'manual',
  );
  const since = new Date(Date.now() - DAY_MS);
  const loads: StepLoad[] = [];
  for (const workflow of workflows) {
    const steps = parseSteps(workflow);
    const trigger = parseTrigger(workflow);
    const ready = trigger.type === 'board_task' ? boardTaskQueue(trigger, state).ready : [];
    const conflict = { contains: 'conflit', mode: 'insensitive' } as const;
    const [runs, recentConflicts, single, lastStarts] = await Promise.all([
      prisma.workflowRun.findMany({ where: { workflowId: workflow.id, status: 'RUNNING' }, select: { steps: { select: { stepId: true, status: true, lane: true, startedAt: true } } } }),
      prisma.workflowRun.count({
        where: { workflowId: workflow.id, status: 'FAILED', finishedAt: { gte: since }, OR: [{ error: conflict }, { steps: { some: { error: conflict } } }] },
      }),
      singleResourceSteps(workflow, steps),
      prisma.workflowStepRun.groupBy({ by: ['stepId'], where: { run: { workflowId: workflow.id } }, _max: { startedAt: true } }),
    ]);
    steps.forEach((step, index) => {
      let active = 0;
      let queued = 0;
      for (const run of runs) {
        const latest = (stepId: string) =>
          run.steps.filter((entry) => entry.stepId === stepId && entry.lane === 'main').sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        const current = latest(step.id);
        if (current?.status === 'RUNNING') active++;
        else if (index > 0 && (!current || current.status === 'RETRIED') && latest(steps[index - 1]!.id)?.status === 'SUCCEEDED') queued++;
      }
      const lastStart = lastStarts.find((entry) => entry.stepId === step.id)?._max.startedAt;
      loads.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        stepId: step.id,
        stepName: step.name,
        index,
        agents: step.agents,
        active,
        queued,
        ready: index === 0 ? ready.map((item) => ({ ref: ref(item), title: item.title })) : [],
        single: single.has(step.id),
        idleMinutes: lastStart ? Math.round((Date.now() - lastStart.getTime()) / 60_000) : null,
        recentConflicts: index === 0 ? recentConflicts : 0,
      });
    });
  }
  return loads;
}

const signalLine = (signal: CapacitySignal) =>
  `${signal.workflowName} · ${signal.stepName}: ${signal.from} → ${signal.to} agente(s) (${signal.reason})`;

function pilotLines(signals: CapacitySignal[], loads: StepLoad[], plan: PlanState, machine: MachineState | null) {
  const percent = (value: number | null) => (value === null ? '?' : `${Math.round(value)}%`);
  const workflows = [...new Set(signals.map((signal) => signal.workflowId))];
  return [
    'Gestor de Capacidade — as regras pedem ajuste de agentes por etapa. Decida cada um e aplique com studio_set_workflow (stepAgents {"<etapa>": N}); não ajuste o que não fizer sentido e diga por quê.',
    ...signals.map((signal) => `- ${signalLine(signal)} [workflowId ${signal.workflowId}]`),
    `Plano: janela de 5 h ${percent(plan.sessionPercent)}, semanal ${percent(plan.weekPercent)} (pausa em ${plan.limitPercent}%). Computador: ${
      machine ? `memória ${Math.round(machine.memoryPercent)}% (limite ${machine.memoryLimit}%), CPU ${Math.round(machine.cpuPercent)}%` : 'desconhecido'
    }.`,
    ...workflows.map(
      (id) =>
        `Etapas de ${loads.find((load) => load.workflowId === id)?.workflowName}: ${loads
          .filter((load) => load.workflowId === id)
          .map((load) => `${load.stepName} ${load.active}/${load.agents}${load.queued ? ` (+${load.queued} na fila)` : ''}${load.single ? ' [recurso único: fica em 1]' : ''}`)
          .join(' → ')}${loads.find((load) => load.workflowId === id && load.index === 0)?.ready.length ? `; ${loads.find((load) => load.workflowId === id && load.index === 0)!.ready.length} tarefa(s) pronta(s)` : ''}.`,
    ),
    'Mais agentes só ajudam se as tarefas não mexem nos mesmos arquivos (conflito de merge). Subir só com o plano e o computador com folga; descer é seguro.',
  ];
}

/** Looks at one workspace; raises its signals only when they changed (and not twice within the cooldown). */
async function reviewWorkspace(workspaceId: string, log: FastifyBaseLogger) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
  const [state, plan, machine] = await Promise.all([boardTaskState(workspaceId), planState(workspaceId), machineState()]);
  const loads = await stepLoads(workspaceId, state);
  if (loads.length === 0) return;
  const signals = capacitySignals(loads, plan, machine);
  const signature = signalsSignature(signals, loads);

  const last = await prisma.capacityReview.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  if ((last?.signature ?? '') === signature) return;

  // A suggestion about a situation that changed is dropped.
  await prisma.capacityReview.updateMany({ where: { workspaceId, status: 'pending' }, data: { status: 'discarded' } });

  if (signals.length === 0) {
    await prisma.capacityReview.create({ data: { workspaceId, signature, signals: [], status: 'none' } });
    return;
  }
  const lastRaised = await prisma.capacityReview.findFirst({ where: { workspaceId, status: { in: ['pilot', 'pending', 'applied'] } }, orderBy: { createdAt: 'desc' } });
  if (lastRaised && Date.now() - lastRaised.createdAt.getTime() < COOLDOWN_MS) return;

  const summary = signals.map(signalLine).join('\n');
  const delivered = await notifyPilot(workspace.ownerId, 'agents', workspaceId, pilotLines(signals, loads, plan, machine)).catch(() => false);
  await prisma.capacityReview.create({
    data: { workspaceId, signature, signals: signals as unknown as Prisma.InputJsonValue, summary, status: delivered ? 'pilot' : 'pending' },
  });
  log.info({ workspaceId, signals: summary, delivered }, 'Capacity signals raised');
}

let reviewing = false;

async function capacityTick(log: FastifyBaseLogger) {
  if (reviewing) return;
  reviewing = true;
  try {
    const workspaces = await prisma.workspace.findMany({ where: { isIgnored: false, missingAt: null, workflows: { some: { isEnabled: true } } }, select: { id: true } });
    for (const { id } of workspaces) {
      await reviewWorkspace(id, log).catch((err) => log.warn({ workspaceId: id, err }, 'Capacity review failed'));
    }
  } finally {
    reviewing = false;
  }
}

export function startCapacityMonitor(log: FastifyBaseLogger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    await capacityTick(log).catch((err) => log.error({ err }, 'Capacity monitor failed'));
    if (!stopped) timer = setTimeout(run, TICK_MS);
  };
  timer = setTimeout(run, 60_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** For the Workflows tab: the pending suggestion and the last change raised (handed to the pilot or applied). */
export async function capacitySummary(workspaceId: string) {
  const [pending, lastRaised] = await Promise.all([
    prisma.capacityReview.findMany({ where: { workspaceId, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 1 }),
    prisma.capacityReview.findFirst({ where: { workspaceId, status: { in: ['pilot', 'applied', 'discarded'] } }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    suggestions: pending.map((review) => ({ id: review.id, summary: review.summary ?? '', createdAt: review.createdAt })),
    last: lastRaised ? { at: lastRaised.createdAt, status: lastRaised.status, summary: lastRaised.summary ?? '' } : null,
  };
}

/** Pending suggestions of every workspace the user sees (Órbi page, menu dots). */
export async function pendingCapacitySuggestions(ownerId: string) {
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId, isIgnored: false, ...(await visibleWorkspaceFilter(ownerId)) },
    select: { id: true, name: true },
  });
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const reviews = await prisma.capacityReview.findMany({
    where: { status: 'pending', workspaceId: { in: [...names.keys()] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, createdAt: true, workspaceId: true },
  });
  return reviews.map((review) => ({ ...review, summary: review.summary ?? '', workspaceName: names.get(review.workspaceId)! }));
}

/** Applies a suggestion (each step gets its new number of agents) or discards it. */
export async function decideCapacitySuggestion(ownerId: string, id: string, decision: 'apply' | 'discard', via: { conversationId?: string; reason?: string } = {}) {
  const review = await prisma.capacityReview.findUnique({ where: { id }, include: { workspace: { select: { ownerId: true } } } });
  if (!review || review.workspace.ownerId !== ownerId) throw notFound('Sugestão de capacidade não encontrada.');
  if (review.status !== 'pending') throw new HttpError(409, 'Esta sugestão já foi decidida ou mudou.');
  if (decision === 'apply') {
    const signals = review.signals as unknown as CapacitySignal[];
    for (const workflowId of new Set(signals.map((signal) => signal.workflowId))) {
      const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
      if (!workflow) continue;
      const steps = parseSteps(workflow).map((step) => {
        const signal = signals.find((entry) => entry.workflowId === workflowId && entry.stepId === step.id);
        return signal ? { ...step, agents: signal.to } : step;
      });
      await updateWorkflow(workflowId, { steps });
    }
  }
  await prisma.capacityReview.update({ where: { id }, data: { status: decision === 'apply' ? 'applied' : 'discarded' } });
  await logActivity({
    ownerId,
    workspaceId: review.workspaceId,
    conversationId: via.conversationId ?? null,
    kind: 'capacity',
    summary: `${decision === 'apply' ? 'Aplicou' : 'Descartou'}: ${review.summary ?? ''}`.slice(0, 500),
    details: { reason: via.reason ?? null },
  });
  return { id, status: decision === 'apply' ? 'applied' : 'discarded' };
}
