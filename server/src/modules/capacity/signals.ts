/**
 * Gestor de Capacidade: plain rules (no AI) that notice when a board workflow could run more or fewer tasks at the
 * same time. Only when the signals change an agent studies them (task overlap, plan) and suggests the change.
 */

export interface WorkflowLoad {
  workflowId: string;
  workflowName: string;
  /** Runs allowed at the same time (1 to 5). */
  max: number;
  running: number;
  /** Tasks the workflow could start now (dependencies delivered). */
  ready: { ref: string; title: string }[];
  /** Tasks in its column still waiting for their "Depende de:" tasks. */
  waiting: number;
  /** Runs of the last day that failed on a merge conflict. */
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

export interface CapacitySignal {
  workflowId: string;
  workflowName: string;
  direction: 'up' | 'down';
  /** Value the rule would move to; the agent may suggest otherwise or nothing. */
  from: number;
  to: number;
  reason: string;
}

/** Below this distance from the pause limit, more runs at once are not suggested. */
const UP_HEADROOM = 20;
/** At this distance from the pause limit, fewer runs at once are suggested. */
const DOWN_MARGIN = 10;
const WEEK_HIGH = 90;
const MAX_RUNS = 5;

export function capacitySignals(loads: WorkflowLoad[], plan: PlanState): CapacitySignal[] {
  const session = plan.sessionPercent;
  const nearLimit = session !== null && session >= plan.limitPercent - DOWN_MARGIN;
  const weekHigh = plan.weekPercent !== null && plan.weekPercent >= WEEK_HIGH;
  const roomForMore = !nearLimit && !weekHigh && (session === null || session < plan.limitPercent - UP_HEADROOM);

  const signals: CapacitySignal[] = [];
  for (const load of loads) {
    const base = { workflowId: load.workflowId, workflowName: load.workflowName, from: load.max };
    if (load.max > 1 && load.recentConflicts > 0) {
      signals.push({ ...base, direction: 'down', to: load.max - 1, reason: `${load.recentConflicts} execução(ões) com conflito de merge nas últimas 24 h` });
    } else if (load.max > 1 && (nearLimit || weekHigh)) {
      signals.push({
        ...base,
        direction: 'down',
        to: 1,
        reason: weekHigh ? `plano semanal em ${Math.round(plan.weekPercent!)}%` : `janela de 5 h em ${Math.round(session!)}% (pausa em ${plan.limitPercent}%)`,
      });
    } else if (roomForMore && load.max < MAX_RUNS && load.running >= load.max && load.ready.length > 0) {
      const to = Math.min(MAX_RUNS, load.max + load.ready.length);
      signals.push({ ...base, direction: 'up', to, reason: `${load.ready.length} tarefa(s) liberada(s) esperando um espaço` });
    }
  }
  return signals;
}

/** Same signals, same tasks: same signature, so the agent is not asked twice about the same situation. */
export function signalsSignature(signals: CapacitySignal[], loads: WorkflowLoad[]) {
  return signals
    .map((signal) => {
      const ready = signal.direction === 'up' ? (loads.find((load) => load.workflowId === signal.workflowId)?.ready ?? []).map((task) => task.ref).sort() : [];
      return `${signal.workflowId}:${signal.direction}:${signal.from}:${ready.join(',')}`;
    })
    .sort()
    .join('|');
}
