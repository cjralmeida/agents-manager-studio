import { prisma } from '../../db.js';
import type { AgentAccount } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';

export interface AgentAccountInput {
  label?: string;
  token?: string;
}

const NOT_FOUND_MESSAGE = 'Conta de agente não encontrada.';

export async function listAgentAccounts() {
  const accounts = await prisma.agentAccount.findMany({
    orderBy: { label: 'asc' },
    include: { _count: { select: { workspaceSettings: true } } },
  });
  return accounts.map(({ _count, ...account }) => ({
    ...toResponse(account),
    workspaceCount: _count.workspaceSettings,
  }));
}

export async function createAgentAccount(input: Required<AgentAccountInput>) {
  const account = await prisma.agentAccount.create({
    data: {
      label: input.label,
      tokenEncrypted: secrets.encrypt(input.token),
      tokenHint: secretHint(input.token),
    },
  });
  return { ...toResponse(account), workspaceCount: 0 };
}

export async function updateAgentAccount(id: string, input: AgentAccountInput) {
  await findOrThrow(id);
  const tokenData = input.token
    ? { tokenEncrypted: secrets.encrypt(input.token), tokenHint: secretHint(input.token) }
    : {};

  const { _count, ...account } = await prisma.agentAccount.update({
    where: { id },
    data: { label: input.label, ...tokenData },
    include: { _count: { select: { workspaceSettings: true } } },
  });
  return { ...toResponse(account), workspaceCount: _count.workspaceSettings };
}

/** Workspaces using the account keep their other settings and lose only the account (ON DELETE SET NULL). */
export async function deleteAgentAccount(id: string) {
  await findOrThrow(id);
  await prisma.agentAccount.delete({ where: { id } });
}

async function findOrThrow(id: string) {
  const account = await prisma.agentAccount.findUnique({ where: { id } });
  if (!account) throw notFound(NOT_FOUND_MESSAGE);
  return account;
}

function toResponse(account: AgentAccount) {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    tokenHint: account.tokenHint,
  };
}
