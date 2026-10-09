import { prisma } from '../../db.js';
import type { Agent, ClickupAccount } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { createClickupClient } from './api.js';

// ---------------------------------------------------------------- accounts

const withUsage = { _count: { select: { workspaceSettings: true } } } as const;

function accountResponse(account: ClickupAccount & { _count: { workspaceSettings: number } }) {
  return {
    id: account.id,
    label: account.label,
    username: account.username,
    tokenHint: account.tokenHint,
    workspaceCount: account._count.workspaceSettings,
  };
}

export async function listClickupAccounts(ownerId: string) {
  const accounts = await prisma.clickupAccount.findMany({ where: { ownerId }, include: withUsage, orderBy: { label: 'asc' } });
  return accounts.map(accountResponse);
}

export async function createClickupAccount(ownerId: string, input: { label: string; token: string }) {
  const { username } = await createClickupClient(input.token).user();
  const account = await prisma.clickupAccount.create({
    data: { ownerId, label: input.label, tokenEncrypted: secrets.encrypt(input.token), tokenHint: secretHint(input.token), username },
    include: withUsage,
  });
  return accountResponse(account);
}

export async function updateClickupAccount(id: string, input: { label?: string; token?: string }) {
  await findAccount(id);
  const tokenData = input.token
    ? { tokenEncrypted: secrets.encrypt(input.token), tokenHint: secretHint(input.token), username: (await createClickupClient(input.token).user()).username }
    : {};
  const account = await prisma.clickupAccount.update({ where: { id }, data: { label: input.label, ...tokenData }, include: withUsage });
  return accountResponse(account);
}

/** Checks the stored token on ClickUp again. */
export async function verifyClickupAccount(id: string) {
  const account = await findAccount(id);
  const { username } = await createClickupClient(secrets.decrypt(account.tokenEncrypted)).user();
  await prisma.clickupAccount.update({ where: { id }, data: { username } });
  return { ok: true as const, username };
}

/** Workspaces using it lose the account (ON DELETE SET NULL). */
export async function deleteClickupAccount(id: string) {
  await findAccount(id);
  await prisma.clickupAccount.delete({ where: { id } });
}

async function findAccount(id: string) {
  const account = await prisma.clickupAccount.findUnique({ where: { id } });
  if (!account) throw notFound('Conta do ClickUp não encontrada.');
  return account;
}

// ---------------------------------------------------------------- agent tools (read-only)

export const CLICKUP_TOOL_NAMES = ['clickup_hierarchy', 'clickup_list_tasks', 'clickup_get_task'] as const;
export type ClickupToolName = (typeof CLICKUP_TOOL_NAMES)[number];

/** Reads ClickUp for an agent with the workspace's account; the token never reaches the agent. */
export async function runClickupTool(agent: Agent, name: ClickupToolName, args: Record<string, unknown>) {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId: agent.workspaceId }, include: { clickupAccount: true } });
  if (!settings?.clickupAccount) throw new HttpError(422, 'O workspace não tem conta do ClickUp. Peça ao usuário para escolher uma na aba Conectores do workspace.');
  const client = createClickupClient(secrets.decrypt(settings.clickupAccount.tokenEncrypted));
  const id = (key: string) => {
    const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
    if (!value) throw new HttpError(400, `Informe ${key}.`);
    return value;
  };

  switch (name) {
    case 'clickup_hierarchy':
      return client.hierarchy();
    case 'clickup_list_tasks':
      return client.listTasks(id('listId'), Math.max(Number(args.page) || 0, 0));
    case 'clickup_get_task':
      return client.task(id('taskId'), args.comments === true);
  }
}
