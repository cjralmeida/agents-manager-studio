import { HttpError } from '../../lib/errors.js';

export type AccountGitProvider = 'GITHUB' | 'GITLAB';

function userEndpoint(provider: AccountGitProvider, host: string) {
  if (provider === 'GITLAB') return `https://${host}/api/v4/user`;
  // GitHub Enterprise serves the REST API under /api/v3.
  return host === 'github.com' ? 'https://api.github.com/user' : `https://${host}/api/v3/user`;
}

function authHeaders(provider: AccountGitProvider, token: string): Record<string, string> {
  if (provider === 'GITLAB') return { 'PRIVATE-TOKEN': token };
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agents-manager-studio',
  };
}

/** Calls the provider's "current user" endpoint to check the token and learn its username. */
export async function fetchGitUsername(provider: AccountGitProvider, host: string, token: string): Promise<string> {
  const response = await fetch(userEndpoint(provider, host), {
    headers: authHeaders(provider, token),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!response) throw new HttpError(502, `Não foi possível conectar a ${host}.`);
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(422, 'Token inválido ou sem permissão para ler o usuário.');
  }
  if (!response.ok) throw new HttpError(502, `${host} respondeu com erro ${response.status}.`);

  const body = (await response.json().catch(() => ({}))) as { login?: unknown; username?: unknown };
  const username = provider === 'GITHUB' ? body.login : body.username;
  if (typeof username !== 'string' || !username) {
    throw new HttpError(502, `Resposta inesperada de ${host}.`);
  }
  return username;
}
