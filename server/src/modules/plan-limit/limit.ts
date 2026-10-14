import type { PlanUsage } from '../usage/calc.js';

/** Waits after the reset so the renewed window is already live when the agent resumes. */
const MARGIN_MS = 2 * 60_000;
/** When neither the message nor the plan tells the reset time, try again after this. */
const FALLBACK_MS = 30 * 60_000;

/** Whether a turn error is Claude's plan limit (5-hour or weekly window), not a real failure. */
export function isPlanLimitError(text: string) {
  return /usage limit|limit reached|hit your (\w+ )?limit|out of extra usage|limite (do plano|de uso)/i.test(text);
}

/** Older Claude Code messages end with the reset as epoch seconds: "Claude AI usage limit reached|1760000000". */
function resetFromText(text: string) {
  const match = /\|(\d{10})\b/.exec(text);
  return match ? new Date(Number(match[1]) * 1000) : null;
}

/** The reset of the window that blocked the account: the full ones (latest reset), else the 5-hour window. */
export function planResetAt(plan: PlanUsage | null | undefined, now = new Date()) {
  const windows = (plan?.windows ?? []).filter((window) => window.resetsAt && new Date(window.resetsAt) > now);
  const full = windows.filter((window) => window.percent >= 100);
  const chosen = full.length > 0 ? full : windows.filter((window) => window.key === 'five_hour');
  const times = chosen.map((window) => new Date(window.resetsAt!).getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

/** When to resume an agent that stopped on the plan limit. */
export function limitResumeAt(text: string, plan: PlanUsage | null | undefined, now = new Date()) {
  const reset = resetFromText(text) ?? planResetAt(plan, now);
  if (reset && reset > now) return new Date(reset.getTime() + MARGIN_MS);
  return new Date(now.getTime() + FALLBACK_MS);
}

/** Whether the plan is still blocked: rejected (or a window full) and its reset is still ahead. */
export function planBlockedUntil(plan: PlanUsage | null | undefined, now = new Date()) {
  if (!plan) return null;
  const full = plan.windows.some((window) => window.percent >= 100);
  if (plan.status !== 'rejected' && !full) return null;
  return planResetAt(plan, now);
}
