import type { RateLimitInfo } from '../usage/calc.js';

export interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
}

/** Last JSON line of `claude -p --output-format json` with type "result". */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ClaudeResult;
      if (parsed.type === 'result') return parsed;
    } catch {
      // Not JSON (e.g. a warning line); keep looking.
    }
  }
  return null;
}

/** Last plan rate-limit info in a `--output-format stream-json` output, if Claude sent one. */
export function parseRateLimit(stdout: string): RateLimitInfo | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type?: string; rate_limit_info?: RateLimitInfo };
      if (parsed.type === 'rate_limit_event' && parsed.rate_limit_info) return parsed.rate_limit_info;
    } catch {
      // Not JSON; keep looking.
    }
  }
  return null;
}
