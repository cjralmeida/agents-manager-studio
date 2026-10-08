import { config } from '../../config.js';
import { imageExists, runOnce } from '../../lib/docker.js';
import { HttpError } from '../../lib/errors.js';
import { parseClaudeResult } from './claude-result.js';

const CHECK_TIMEOUT_MS = 90_000;

/**
 * Checks a subscription token the same way agents use it: runs the Claude Code CLI
 * in the agent-runner image with a tiny prompt on the cheapest model.
 */
export async function verifyClaudeToken(token: string) {
  if (!(await imageExists(config.agentRunnerImage))) {
    throw new HttpError(
      503,
      'Imagem do agent-runner não encontrada. Rode: docker compose --profile tools build agent-runner',
    );
  }

  const run = await runOnce({
    image: config.agentRunnerImage,
    cmd: ['claude', '-p', 'Responda apenas com a palavra OK.', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json'],
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    labels: { 'agents-manager-studio.role': 'account-check' },
    timeoutMs: CHECK_TIMEOUT_MS,
  });

  if (run.timedOut) throw new HttpError(504, 'O Claude Code não respondeu a tempo. Tente novamente.');

  const result = parseClaudeResult(run.stdout);
  if (!result) throw new HttpError(502, 'Resposta inesperada do Claude Code.');
  if (result.api_error_status === 401 || result.api_error_status === 403) {
    throw new HttpError(422, 'Token inválido ou expirado. Gere outro com `claude setup-token`.');
  }
  if (result.is_error) {
    throw new HttpError(502, `Falha no Claude Code: ${(result.result ?? 'erro desconhecido').slice(0, 300)}`);
  }
  return { ok: true as const };
}
