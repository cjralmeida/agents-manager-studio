/**
 * Gestor de Capacidade: plain rules (no AI) that notice when a step of a workflow could use one agent more or fewer.
 * Workflows are production lines: each step has its own agents, and tasks wait in a step's queue while they are busy.
 * The pilot (Órbi) gets the signals and adjusts; without it, they become suggestions the user applies.
 */

export interface StepLoad {
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepName: string;
  /** Position of the step in its workflow (0 takes new tasks from the board). */
  index: number;
  /** Agents set for the step (1 to 5). */
  agents: number;
  /** Agents working it now. */
  active: number;
  /** Tasks waiting for a free agent at this step. */
  queued: number;
  /** First step only: tasks the workflow could start now (dependencies delivered). */
  ready: { ref: string; title: string }[];
  /** A step with a single resource (publishing to homologation, testing in homologation): it stays at one agent. */
  single: boolean;
  /** Minutes since an agent last started at this step (time with the Studio off left out), or null when it never did. */
  idleMinutes: number | null;
  /** First step only: tasks the workflow takes once their dependencies are delivered (work on its way). */
  upcoming?: number;
  /** First step only: runs of the last day that failed on a merge conflict. */
  recentConflicts: number;
}

export interface PlanState {
  /** 5-hour window of the Claude plan, 0-100, or null when unknown. */
  sessionPercent: number | null;
  /** 7-day window, 0-100, or null when unknown. */
  weekPercent: number | null;
  /** Where the workflows pause (WORKFLOW_PLAN_LIMIT_PERCENT). */
  limitPercent: number;
}

/** The computer the agents run on (Windows helper numbers, or the Docker VM when the helper is off). */
export interface MachineState {
  memoryPercent: number;
  cpuPercent: number;
  /** Free space (GB) on the disk of the agent copies, or null when unknown. */
  freeDiskGb: number | null;
  /** The launch limits (AGENT_LAUNCH_*): at these values workflows stop starting agents. */
  memoryLimit: number;
  cpuLimit: number;
  minFreeDiskGb: number;
  source: 'host' | 'docker';
}

export interface CapacitySignal {
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepName: string;
  direction: 'up' | 'down';
  from: number;
  to: number;
  reason: string;
}

/** Below this distance from the pause limit, more agents are not suggested. */
const UP_HEADROOM = 20;
/** At this distance from the pause limit, fewer agents are suggested. */
const DOWN_MARGIN = 10;
const WEEK_HIGH = 90;
const MAX_AGENTS = 5;
/** Tasks waiting at a later step that ask for one more agent there. */
const QUEUE_FOR_MORE = 2;
/** A step with more than one agent and nothing to do for this long gives one back. */
const IDLE_MINUTES = 60;

/** Below this distance (points) from the memory or CPU limit, more agents are not suggested. */
const MACHINE_HEADROOM = 10;

/** Why the computer cannot take more agents: at its limits (suggest fewer) or just without room (suggest no more). */
export function machinePressure(machine: MachineState | null) {
  if (!machine) return { overloaded: null, busy: false };
  const where = machine.source === 'host' ? 'do computador' : 'do Docker';
  const diskShort = machine.freeDiskGb !== null && machine.freeDiskGb < machine.minFreeDiskGb;
  // CPU spikes a lot between samples: it only holds back more agents; memory and disk also ask for fewer.
  const overloaded =
    machine.memoryPercent >= machine.memoryLimit
      ? `memória ${where} em ${Math.round(machine.memoryPercent)}% (limite ${machine.memoryLimit}%)`
      : diskShort
        ? `disco das cópias com ${machine.freeDiskGb!.toFixed(1)} GB livres (mínimo ${machine.minFreeDiskGb} GB)`
        : null;
  const busy =
    overloaded !== null ||
    machine.memoryPercent >= machine.memoryLimit - MACHINE_HEADROOM ||
    machine.cpuPercent >= machine.cpuLimit - MACHINE_HEADROOM;
  return { overloaded, busy };
}

/**
 * At most one signal per step. Fewer agents when merges conflict (first step), the computer or the plan are at their
 * limits, or a step sits idle; one more where work waits: ready tasks at a busy first step (while the line is not
 * backed up), or a queue at a later step. Single-resource steps never go up.
 */
export function capacitySignals(steps: StepLoad[], plan: PlanState, machine: MachineState | null = null): CapacitySignal[] {
  const session = plan.sessionPercent;
  const nearLimit = session !== null && session >= plan.limitPercent - DOWN_MARGIN;
  const weekHigh = plan.weekPercent !== null && plan.weekPercent >= WEEK_HIGH;
  const pressure = machinePressure(machine);
  const roomForMore = !nearLimit && !weekHigh && !pressure.busy && (session === null || session < plan.limitPercent - UP_HEADROOM);
  const planReason = weekHigh ? `plano semanal em ${Math.round(plan.weekPercent ?? 0)}%` : `janela de 5 h em ${Math.round(session ?? 0)}% (pausa em ${plan.limitPercent}%)`;

  const signals: CapacitySignal[] = [];
  for (const step of steps) {
    const base = { workflowId: step.workflowId, workflowName: step.workflowName, stepId: step.stepId, stepName: step.stepName, from: step.agents };
    const down = (reason: string) => signals.push({ ...base, direction: 'down', to: step.agents - 1, reason });
    if (step.agents > 1) {
      if (step.index === 0 && step.recentConflicts > 0) {
        down(`${step.recentConflicts} tarefa(s) com conflito de merge nas últimas 24 h`);
        continue;
      }
      if (pressure.overloaded) {
        down(pressure.overloaded);
        continue;
      }
      if (nearLimit || weekHigh) {
        down(planReason);
        continue;
      }
      // Work on its way keeps a step's agents: an earlier step of the workflow working or holding tasks, or tasks
      // that only wait for their dependencies (e.g. a chain of lots unlocked by one task).
      const line = steps.filter((other) => other.workflowId === step.workflowId);
      const comingFromBefore = line.some((other) => other.index < step.index && (other.active > 0 || other.queued > 0 || other.ready.length > 0));
      const upcoming = line.some((other) => other.index === 0 && (other.upcoming ?? 0) > 0);
      const nothingToDo = step.active === 0 && step.queued === 0 && step.ready.length === 0 && !comingFromBefore && !upcoming;
      if (nothingToDo && step.idleMinutes !== null && step.idleMinutes >= IDLE_MINUTES) {
        down(`sem trabalho há ${step.idleMinutes} min`);
        continue;
      }
    }
    if (!roomForMore || step.single || step.agents >= MAX_AGENTS) continue;
    if (step.index === 0) {
      const lineBackedUp = steps.some((other) => other.workflowId === step.workflowId && other.index > 0 && other.queued >= QUEUE_FOR_MORE);
      if (step.active >= step.agents && step.ready.length > 0 && !lineBackedUp) {
        signals.push({ ...base, direction: 'up', to: step.agents + 1, reason: `${step.ready.length} tarefa(s) pronta(s) esperando um agente livre` });
      }
    } else if (step.queued >= QUEUE_FOR_MORE && step.active >= step.agents) {
      signals.push({ ...base, direction: 'up', to: step.agents + 1, reason: `${step.queued} tarefa(s) na fila desta etapa` });
    }
  }
  return signals;
}

/** Same signals about the same tasks: same signature, so the same situation is not raised twice. */
export function signalsSignature(signals: CapacitySignal[], steps: StepLoad[]) {
  return signals
    .map((signal) => {
      const step = steps.find((entry) => entry.workflowId === signal.workflowId && entry.stepId === signal.stepId);
      const ready = signal.direction === 'up' ? (step?.ready ?? []).map((task) => task.ref).sort() : [];
      return `${signal.workflowId}:${signal.stepId}:${signal.direction}:${signal.from}:${ready.join(',')}`;
    })
    .sort()
    .join('|');
}
