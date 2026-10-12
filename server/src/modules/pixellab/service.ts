import { prisma } from '../../db.js';
import type { PixellabAccount } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';

/**
 * PixelLab (pixel art generation): an account is an API token. Agents with the "pixellab" tool get PixelLab's hosted MCP
 * server (https://api.pixellab.ai/mcp) in their runner; the token is handed to the runner only, never to the agent.
 */

export const PIXELLAB_MCP_URL = 'https://api.pixellab.ai/mcp';
const API = 'https://api.pixellab.ai/v1';

/** Credits left on the account; also proves the token works. */
async function balance(token: string) {
  const response = await fetch(`${API}/balance`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) throw new HttpError(502, 'Não foi possível conectar ao PixelLab.');
  if (response.status === 401 || response.status === 403) throw new HttpError(422, 'O PixelLab recusou o token: confira o token na página da sua conta do PixelLab.');
  if (!response.ok) throw new HttpError(502, `O PixelLab respondeu ${response.status} ao conferir o token.`);
  const body = (await response.json().catch(() => ({}))) as { usd?: number; credits?: number };
  return { usd: typeof body.usd === 'number' ? body.usd : null, credits: typeof body.credits === 'number' ? body.credits : null };
}

const withUsage = { _count: { select: { workspaceSettings: true } } } as const;

function accountResponse(account: PixellabAccount & { _count: { workspaceSettings: number } }) {
  return { id: account.id, label: account.label, tokenHint: account.tokenHint, workspaceCount: account._count.workspaceSettings };
}

export async function listPixellabAccounts(ownerId: string) {
  const accounts = await prisma.pixellabAccount.findMany({ where: { ownerId }, include: withUsage, orderBy: { label: 'asc' } });
  return accounts.map(accountResponse);
}

export async function createPixellabAccount(ownerId: string, input: { label: string; token: string }) {
  await balance(input.token);
  const account = await prisma.pixellabAccount.create({
    data: { ownerId, label: input.label, tokenEncrypted: secrets.encrypt(input.token), tokenHint: secretHint(input.token) },
    include: withUsage,
  });
  return accountResponse(account);
}

export async function updatePixellabAccount(id: string, input: { label?: string; token?: string }) {
  await findAccount(id);
  if (input.token) await balance(input.token);
  const tokenData = input.token ? { tokenEncrypted: secrets.encrypt(input.token), tokenHint: secretHint(input.token) } : {};
  const account = await prisma.pixellabAccount.update({ where: { id }, data: { label: input.label, ...tokenData }, include: withUsage });
  return accountResponse(account);
}

/** Checks the stored token on PixelLab again and returns the balance. */
export async function verifyPixellabAccount(id: string) {
  const account = await findAccount(id);
  return { ok: true as const, ...(await balance(secrets.decrypt(account.tokenEncrypted))) };
}

/** Workspaces using it lose the account (ON DELETE SET NULL). */
export async function deletePixellabAccount(id: string) {
  await findAccount(id);
  await prisma.pixellabAccount.delete({ where: { id } });
}

async function findAccount(id: string) {
  const account = await prisma.pixellabAccount.findUnique({ where: { id } });
  if (!account) throw notFound('Conta do PixelLab não encontrada.');
  return account;
}

/** Token for an agent's runner: only when the agent has the "pixellab" tool and its workspace has an account. */
export async function pixellabTokenFor(workspaceId: string, tools: string[]) {
  if (!tools.includes('pixellab')) return null;
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { pixellabAccount: true } });
  return settings?.pixellabAccount ? secrets.decrypt(settings.pixellabAccount.tokenEncrypted) : null;
}
