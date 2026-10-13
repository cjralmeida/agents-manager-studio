const HOUR_MS = 60 * 60_000;
export const FINISHED = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;

/** Whether a finished agent's copy may go: past its retention (none when the disk is short) and no running run needs it. */
export function copyExpired(
  agent: { status: string; finishedAt: Date | null; lastActivityAt: Date; runStatus: string | null },
  now: Date,
  retention: { completedHours: number; failedDays: number; diskShort: boolean },
) {
  if (!(FINISHED as readonly string[]).includes(agent.status) || agent.runStatus === 'RUNNING') return false;
  if (retention.diskShort) return true;
  const finished = (agent.finishedAt ?? agent.lastActivityAt).getTime();
  const keepMs = agent.status === 'COMPLETED' ? retention.completedHours * HOUR_MS : retention.failedDays * 24 * HOUR_MS;
  return now.getTime() - finished >= keepMs;
}
