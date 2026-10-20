import { randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { secrets } from '../../lib/secrets.js';

/**
 * Webhooks of the git providers: the boards are read again as soon as a task changes, instead of waiting for the next
 * periodic read. They reach the Studio through a public address (the ngrok tunnel), saved here with the secret the
 * providers sign every delivery with.
 */
const CONFIG_KEY = 'webhooks';
const LAST_KEY = 'webhooks:last';
const boardKey = (boardId: string) => `webhooks:board:${boardId}`;

interface StoredConfig {
  secretEncrypted: string;
  publicUrl: string | null;
}

/** How a board's webhook was set up at the provider. */
export interface BoardWebhookState {
  ok: boolean;
  /** Where the hook lives: the GitHub organization, the GitLab group, or each project of the group. */
  scope: 'organization' | 'group' | 'projects' | null;
  /** Hook ids at the provider ("<project id>:<hook id>" for project hooks), to update or delete them later. */
  hookIds: string[];
  error: string | null;
  at: string;
}

async function read<T>(key: string) {
  const row = await prisma.studioSetting.findUnique({ where: { key } });
  return (row?.value as unknown as T | undefined) ?? null;
}

async function write(key: string, value: unknown) {
  const json = value as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
}

/** The secret and the public address; the secret is made on first use. */
export async function webhookConfig() {
  let stored = await read<StoredConfig>(CONFIG_KEY);
  if (!stored) {
    stored = { secretEncrypted: secrets.encrypt(randomBytes(32).toString('hex')), publicUrl: null };
    await write(CONFIG_KEY, stored);
  }
  return { secret: secrets.decrypt(stored.secretEncrypted), publicUrl: stored.publicUrl };
}

export async function savePublicUrl(publicUrl: string | null) {
  const { secret } = await webhookConfig();
  await write(CONFIG_KEY, { secretEncrypted: secrets.encrypt(secret), publicUrl } satisfies StoredConfig);
}

/** The address each provider delivers to. */
export function receiverUrl(publicUrl: string, provider: 'GITHUB' | 'GITLAB') {
  return `${publicUrl.replace(/\/+$/, '')}/api/webhooks/${provider === 'GITHUB' ? 'github' : 'gitlab'}`;
}

export const boardWebhookState = (boardId: string) => read<BoardWebhookState>(boardKey(boardId));
export const saveBoardWebhookState = (boardId: string, state: BoardWebhookState) => write(boardKey(boardId), state);
export const forgetBoardWebhookState = (boardId: string) => prisma.studioSetting.deleteMany({ where: { key: boardKey(boardId) } });

export interface LastDelivery {
  at: string;
  provider: 'GITHUB' | 'GITLAB';
  event: string;
  owner: string | null;
  boards: number;
}

export const lastDelivery = () => read<LastDelivery>(LAST_KEY);
export const saveLastDelivery = (delivery: LastDelivery) => write(LAST_KEY, delivery);
