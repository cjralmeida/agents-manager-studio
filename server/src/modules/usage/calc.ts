/** Usage of one model as reported by the Agent SDK (cumulative for the session). */
export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export type UsageTotals = Record<string, ModelTotals>;

export interface UsageDelta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'] as const;

/**
 * What was used since the previous report. Reports are running totals; when a total goes down
 * (a new session without the saved totals) the new report counts from zero.
 */
export function usageDeltas(previous: UsageTotals, next: UsageTotals): UsageDelta[] {
  const deltas: UsageDelta[] = [];
  for (const [model, totals] of Object.entries(next)) {
    const before = previous[model];
    const reset = !before || KEYS.some((key) => (totals[key] ?? 0) < (before[key] ?? 0));
    const diff = (key: (typeof KEYS)[number]) => (totals[key] ?? 0) - (reset ? 0 : (before[key] ?? 0));
    const delta = {
      model,
      inputTokens: diff('inputTokens'),
      outputTokens: diff('outputTokens'),
      cacheReadTokens: diff('cacheReadInputTokens'),
      cacheCreationTokens: diff('cacheCreationInputTokens'),
      costUsd: diff('costUSD'),
    };
    if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens || delta.cacheCreationTokens || delta.costUsd) {
      deltas.push(delta);
    }
  }
  return deltas;
}

/** Keeps the cumulative fields of the reports per model; later reports replace earlier ones. */
export function mergeTotals(previous: UsageTotals, next: UsageTotals): UsageTotals {
  const merged: UsageTotals = { ...previous };
  for (const [model, totals] of Object.entries(next)) {
    merged[model] = Object.fromEntries(KEYS.map((key) => [key, totals[key] ?? 0])) as unknown as ModelTotals;
  }
  return merged;
}

// ---------------------------------------------------------------- plan limits

/** Rate-limit info Claude sends with each request on subscription plans (`rate_limit_event`). */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | null>;
}

export interface PlanWindow {
  /** five_hour, seven_day, seven_day_opus, ... */
  key: string;
  label: string;
  /** 0-100. */
  percent: number;
  resetsAt: string | null;
}

export interface PlanUsage {
  status: string | null;
  windows: PlanWindow[];
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Sessão (5 horas)',
  seven_day: 'Semanal',
  seven_day_opus: 'Semanal · Opus',
  seven_day_sonnet: 'Semanal · Sonnet',
};
const WINDOW_ORDER = Object.keys(WINDOW_LABELS);

const toIso = (seconds: number | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);
/** Utilization comes as a fraction (0.26 = 26%). */
const toPercent = (utilization: number) => Math.round(utilization * 1000) / 10;

export function normalizePlanUsage(info: RateLimitInfo): PlanUsage {
  const windows: PlanWindow[] = [];
  for (const [key, window] of Object.entries(info.unifiedWindows ?? {})) {
    if (!window || typeof window.utilization !== 'number') continue;
    windows.push({ key, label: WINDOW_LABELS[key] ?? key, percent: toPercent(window.utilization), resetsAt: toIso(window.resetsAt) });
  }
  // Older reports carry only the window that triggered the event.
  if (windows.length === 0 && info.rateLimitType && typeof info.utilization === 'number') {
    windows.push({
      key: info.rateLimitType,
      label: WINDOW_LABELS[info.rateLimitType] ?? info.rateLimitType,
      percent: toPercent(info.utilization),
      resetsAt: toIso(info.resetsAt),
    });
  }
  const rank = (key: string) => (WINDOW_ORDER.includes(key) ? WINDOW_ORDER.indexOf(key) : WINDOW_ORDER.length);
  windows.sort((a, b) => rank(a.key) - rank(b.key));
  return { status: info.status ?? null, windows };
}
