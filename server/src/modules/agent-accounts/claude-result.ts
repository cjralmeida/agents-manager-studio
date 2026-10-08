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
