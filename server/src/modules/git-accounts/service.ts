import { prisma } from '../../db.js';
import type { GitAccount } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { type AccountGitProvider, fetchGitUsername } from './provider-api.js';

export interface CreateGitAccountInput {
  provider: AccountGitProvider;
  label: string;
  host: string;
  token: string;
  authorName?: string | null;
  authorEmail?: string | null;
}

export interface UpdateGitAccountInput {
  label?: string;
  token?: string;
  authorName?: string | null;
  authorEmail?: string | null;
}

const NOT_FOUND_MESSAGE = 'Conta git não encontrada.';

export async function listGitAccounts() {
  const accounts = await prisma.gitAccount.findMany({
    orderBy: [{ provider: 'asc' }, { label: 'asc' }],
    include: { _count: { select: { workspaces: true } } },
  });
  return accounts.map(({ _count, ...account }) => ({ ...toResponse(account), workspaceCount: _count.workspaces }));
}

/** The token is verified with the provider before saving; the username comes from that check. */
export async function createGitAccount(input: CreateGitAccountInput) {
  const username = await fetchGitUsername(input.provider, input.host, input.token);
  const account = await prisma.gitAccount.create({
    data: {
      provider: input.provider,
      label: input.label,
      host: input.host,
      username,
      tokenEncrypted: secrets.encrypt(input.token),
      tokenHint: secretHint(input.token),
      authorName: input.authorName ?? null,
      authorEmail: input.authorEmail ?? null,
    },
  });
  return { ...toResponse(account), workspaceCount: 0 };
}

export async function updateGitAccount(id: string, input: UpdateGitAccountInput) {
  const account = await findOrThrow(id);
  const tokenData = input.token
    ? {
        username: await fetchGitUsername(account.provider as AccountGitProvider, account.host, input.token),
        tokenEncrypted: secrets.encrypt(input.token),
        tokenHint: secretHint(input.token),
      }
    : {};

  const updated = await prisma.gitAccount.update({
    where: { id },
    data: { label: input.label, authorName: input.authorName, authorEmail: input.authorEmail, ...tokenData },
    include: { _count: { select: { workspaces: true } } },
  });
  const { _count, ...rest } = updated;
  return { ...toResponse(rest), workspaceCount: _count.workspaces };
}

/** Re-checks the stored token (e.g. after it was revoked or expired on the provider). */
export async function verifyGitAccount(id: string) {
  const account = await findOrThrow(id);
  const username = await fetchGitUsername(
    account.provider as AccountGitProvider,
    account.host,
    secrets.decrypt(account.tokenEncrypted),
  );
  if (username !== account.username) {
    await prisma.gitAccount.update({ where: { id }, data: { username } });
  }
  return { username };
}

export async function deleteGitAccount(id: string) {
  await findOrThrow(id);
  await prisma.gitAccount.delete({ where: { id } });
}

async function findOrThrow(id: string) {
  const account = await prisma.gitAccount.findUnique({ where: { id } });
  if (!account) throw notFound(NOT_FOUND_MESSAGE);
  return account;
}

function toResponse(account: GitAccount) {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    host: account.host,
    username: account.username,
    authorName: account.authorName,
    authorEmail: account.authorEmail,
    tokenHint: account.tokenHint,
  };
}
