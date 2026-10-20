import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { TaskBoard } from '../../generated/prisma/client.js';
import { secrets } from '../../lib/secrets.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { type BoardWebhookState, boardWebhookState, forgetBoardWebhookState, receiverUrl, saveBoardWebhookState, webhookConfig } from './settings.js';

/**
 * Sets up, at the provider, the webhook that tells the Studio a board's tasks changed. Done by the Studio when a board
 * is linked (and again for every board when the public address changes, and daily for new GitLab projects):
 * - GitHub: an organization hook (the only one GitHub sends Projects events from; needs an owner of the organization
 *   and the token scope admin:org_hook). A user's project has no such events and stays on the periodic read.
 * - GitLab: a group hook (paid plans), else one hook in each project of the group (needs Maintainer).
 * Failures are kept in the board's state and shown in the Studio; the periodic read goes on either way.
 */

type Json = Record<string, unknown>;

async function call(url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }) {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { ...init.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

const reason = (status: number, body: unknown) => {
  const message = (body as Json | null)?.message ?? (body as Json | null)?.error;
  return `${status}${message ? `: ${typeof message === 'string' ? message : JSON.stringify(message)}` : ''}`;
};

async function tokenFor(board: TaskBoard) {
  const account = await findWorkspaceGitAccount(board.workspaceId, [board.host]);
  return secrets.decrypt(account.tokenEncrypted);
}

// ---------------------------------------------------------------- GitHub

const gitHubApi = (host: string) => (host === 'github.com' || host === 'api.github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
const gitHubHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' });
const GITHUB_EVENTS = ['projects_v2_item', 'issues', 'pull_request'];

async function ensureGitHub(board: TaskBoard, url: string, secret: string, previous: BoardWebhookState | null): Promise<BoardWebhookState> {
  const base = `${gitHubApi(board.host)}/orgs/${encodeURIComponent(board.ownerPath)}/hooks`;
  const headers = gitHubHeaders(await tokenFor(board));
  const list = await call(`${base}?per_page=100`, { headers });
  if (list.status === 404) {
    return failed('organization', `O GitHub só envia eventos de Projects para organizações, e "${board.ownerPath}" não é uma (ou o token não tem o escopo admin:org_hook). Este quadro segue pela leitura periódica.`);
  }
  if (list.status !== 200) return failed('organization', `O GitHub recusou ler os webhooks da organização (${reason(list.status, list.body)}). Precisa de um dono da organização e do escopo admin:org_hook no token.`);
  const hooks = list.body as { id: number; config?: { url?: string } }[];
  const existing = hooks.find((hook) => hook.config?.url === url || previous?.hookIds.includes(String(hook.id)));
  const data = { name: 'web', active: true, events: GITHUB_EVENTS, config: { url, content_type: 'json', secret, insecure_ssl: '0' } };
  const saved = existing
    ? await call(`${base}/${existing.id}`, { method: 'PATCH', headers, body: data })
    : await call(base, { method: 'POST', headers, body: data });
  if (saved.status !== 200 && saved.status !== 201) {
    return failed('organization', `O GitHub recusou o webhook da organização (${reason(saved.status, saved.body)}). Precisa de um dono da organização e do escopo admin:org_hook no token.`);
  }
  return ok('organization', [String((saved.body as { id: number }).id)]);
}

async function removeGitHub(board: TaskBoard, state: BoardWebhookState) {
  const headers = gitHubHeaders(await tokenFor(board));
  for (const id of state.hookIds) {
    await call(`${gitHubApi(board.host)}/orgs/${encodeURIComponent(board.ownerPath)}/hooks/${id}`, { method: 'DELETE', headers });
  }
}

// ---------------------------------------------------------------- GitLab

const gitLabApi = (host: string) => `https://${host}/api/v4`;
const gitLabEvents = (url: string, secret: string) => ({
  url,
  token: secret,
  issues_events: true,
  merge_requests_events: true,
  push_events: false,
  note_events: false,
  enable_ssl_verification: true,
});
const groupIdOf = (board: TaskBoard) => Number(board.externalId.split(':')[0]);

async function ensureGitLab(board: TaskBoard, url: string, secret: string, previous: BoardWebhookState | null): Promise<BoardWebhookState> {
  const api = gitLabApi(board.host);
  const headers = { 'PRIVATE-TOKEN': await tokenFor(board) };
  const groupId = groupIdOf(board);
  const data = gitLabEvents(url, secret);

  // A group hook covers every project, also the ones created later (GitLab Premium).
  const groupHooks = await call(`${api}/groups/${groupId}/hooks?per_page=100`, { headers });
  if (groupHooks.status === 200) {
    const existing = (groupHooks.body as { id: number; url: string }[]).find(
      (hook) => hook.url === url || previous?.hookIds.includes(String(hook.id)),
    );
    const saved = existing
      ? await call(`${api}/groups/${groupId}/hooks/${existing.id}`, { method: 'PUT', headers, body: data })
      : await call(`${api}/groups/${groupId}/hooks`, { method: 'POST', headers, body: data });
    if (saved.status === 200 || saved.status === 201) {
      if (previous?.scope === 'projects') await removeGitLabProjectHooks(api, headers, previous);
      return ok('group', [String((saved.body as { id: number }).id)]);
    }
  }

  // Otherwise one hook per project of the group (and its subgroups).
  const projects: { id: number; path_with_namespace: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await call(`${api}/groups/${groupId}/projects?include_subgroups=true&archived=false&per_page=100&page=${page}`, { headers });
    if (batch.status !== 200) return failed('projects', `O GitLab recusou listar os projetos do grupo (${reason(batch.status, batch.body)}).`);
    const items = batch.body as { id: number; path_with_namespace: string }[];
    projects.push(...items);
    if (items.length < 100) break;
  }
  const hookIds: string[] = [];
  const refused: string[] = [];
  for (const project of projects) {
    const list = await call(`${api}/projects/${project.id}/hooks?per_page=100`, { headers });
    if (list.status !== 200) {
      refused.push(`${project.path_with_namespace} (${reason(list.status, list.body)})`);
      continue;
    }
    const existing = (list.body as { id: number; url: string }[]).find(
      (hook) => hook.url === url || previous?.hookIds.includes(`${project.id}:${hook.id}`),
    );
    const saved = existing
      ? await call(`${api}/projects/${project.id}/hooks/${existing.id}`, { method: 'PUT', headers, body: data })
      : await call(`${api}/projects/${project.id}/hooks`, { method: 'POST', headers, body: data });
    if (saved.status === 200 || saved.status === 201) hookIds.push(`${project.id}:${(saved.body as { id: number }).id}`);
    else refused.push(`${project.path_with_namespace} (${reason(saved.status, saved.body)})`);
  }
  if (hookIds.length === 0) {
    return failed('projects', `O GitLab recusou os webhooks: o grupo precisa do plano pago ou a conta precisa ser Maintainer dos projetos. ${refused.join('; ')}`.trim());
  }
  return {
    ...ok('projects', hookIds),
    error: refused.length > 0 ? `Sem webhook (a conta precisa ser Maintainer): ${refused.join('; ')}` : null,
  };
}

async function removeGitLabProjectHooks(api: string, headers: Record<string, string>, state: BoardWebhookState) {
  for (const id of state.hookIds) {
    const [projectId, hookId] = id.split(':');
    if (projectId && hookId) await call(`${api}/projects/${projectId}/hooks/${hookId}`, { method: 'DELETE', headers });
  }
}

async function removeGitLab(board: TaskBoard, state: BoardWebhookState) {
  const api = gitLabApi(board.host);
  const headers = { 'PRIVATE-TOKEN': await tokenFor(board) };
  if (state.scope === 'group') {
    for (const id of state.hookIds) await call(`${api}/groups/${groupIdOf(board)}/hooks/${id}`, { method: 'DELETE', headers });
  } else {
    await removeGitLabProjectHooks(api, headers, state);
  }
}

// ---------------------------------------------------------------- shared

const ok = (scope: BoardWebhookState['scope'], hookIds: string[]): BoardWebhookState => ({ ok: true, scope, hookIds, error: null, at: new Date().toISOString() });
const failed = (scope: BoardWebhookState['scope'], error: string): BoardWebhookState => ({ ok: false, scope, hookIds: [], error, at: new Date().toISOString() });

/** Creates or updates the board's webhook; null when there is no public address yet or the board is the Studio's own. */
export async function ensureBoardWebhook(board: TaskBoard) {
  if (board.provider === 'STUDIO') return null;
  const { secret, publicUrl } = await webhookConfig();
  if (!publicUrl) return null;
  const provider = board.provider as 'GITHUB' | 'GITLAB';
  const previous = await boardWebhookState(board.id);
  const url = receiverUrl(publicUrl, provider);
  let state: BoardWebhookState;
  try {
    state = provider === 'GITHUB' ? await ensureGitHub(board, url, secret, previous) : await ensureGitLab(board, url, secret, previous);
  } catch (error) {
    state = failed(previous?.scope ?? null, error instanceof Error ? error.message : String(error));
    if (previous?.ok) state = { ...state, hookIds: previous.hookIds };
  }
  await saveBoardWebhookState(board.id, state);
  return state;
}

/** Deletes the board's webhook at the provider (the board was unlinked). Failures are ignored: the hook only adds calls. */
export async function removeBoardWebhook(board: TaskBoard) {
  const state = await boardWebhookState(board.id);
  if (state && state.hookIds.length > 0) {
    await (board.provider === 'GITHUB' ? removeGitHub(board, state) : removeGitLab(board, state)).catch(() => undefined);
  }
  await forgetBoardWebhookState(board.id);
}

/** Every linked board, one after another (the public address changed, or the daily check). */
export async function ensureAllBoardWebhooks() {
  const boards = await prisma.taskBoard.findMany({ where: { provider: { not: 'STUDIO' } }, orderBy: { createdAt: 'asc' } });
  for (const board of boards) await ensureBoardWebhook(board);
}

const UPKEEP_MS = 6 * 60 * 60_000;

/** Every few hours the hooks are checked again: new GitLab projects get theirs, and one deleted at the provider comes back. */
export function startWebhookUpkeep(log: FastifyBaseLogger) {
  const timer = setInterval(() => {
    void ensureAllBoardWebhooks().catch((err: unknown) => log.warn({ err }, 'Webhook upkeep failed'));
  }, UPKEEP_MS);
  return () => clearInterval(timer);
}
