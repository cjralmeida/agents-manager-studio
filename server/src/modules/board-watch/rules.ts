/** The last run of a stuck task, as the board watch reads it. */
export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowEnabled: boolean;
  /** Started by a task on the board (can be started again for the same task). */
  boardTriggered: boolean;
  status: string;
  error: string | null;
  runsLastDay: number;
}

/** Failures that say nothing about the work: the machine, the network, the provider or the plan got in the way. */
const PASSING_FAILURE =
  /clone failed|interrompid|n[ãa]o foi poss[ií]vel conectar|fetch failed|econn|etimedout|timed? ?out|sem resposta|limite do plano|session limit|hit your|usage limit|\b50[0-9]\b|reiniciou|parou de forma inesperada/i;

/** Why a task with nothing going on is stuck, and whether running its workflow again is the fix. */
export function stuckReason(column: string, run: RunSummary | null, maxRetries: number) {
  if (!run) return { reason: `Nenhum workflow pegou a tarefa em "${column}".`, retriable: false };
  if (run.status === 'FAILED') {
    const error = (run.error ?? 'sem detalhe').replace(/\s+/g, ' ').slice(0, 300);
    const passing = PASSING_FAILURE.test(error);
    const retriable = passing && run.workflowEnabled && run.boardTriggered && run.runsLastDay < maxRetries + 1;
    return { reason: `O último "${run.workflowName}" falhou: ${error}`, retriable };
  }
  if (run.status === 'CANCELLED') return { reason: `O último "${run.workflowName}" foi cancelado e ninguém retomou.`, retriable: false };
  return { reason: `O último "${run.workflowName}" terminou, mas a tarefa ficou em "${column}".`, retriable: false };
}
