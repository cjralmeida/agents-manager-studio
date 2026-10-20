import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { syncWorkspaceSoon } from '../workflows/scheduler.js';
import { commentLessonsOnOpen } from './mr-lessons.js';
import { saveLastDelivery, webhookConfig } from './settings.js';

type Json = Record<string, unknown>;

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** GitLab sends the secret as is in X-Gitlab-Token. */
export async function verifyGitLab(token: string | undefined) {
  const { secret } = await webhookConfig();
  if (!token || !sameText(token, secret)) throw new HttpError(401, 'Webhook não reconhecido.');
}

/** GitHub signs the raw body with the secret (X-Hub-Signature-256: sha256=<hmac>). */
export async function verifyGitHub(signature: string | undefined, rawBody: string) {
  const { secret } = await webhookConfig();
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (!signature || !sameText(signature, expected)) throw new HttpError(401, 'Webhook não reconhecido.');
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * A task, a PR/MR or a board item changed at the provider: the boards of that GitLab group or GitHub owner are read
 * again now (and the workflows look for new tasks), instead of at the next periodic read.
 */
export async function receiveDelivery(provider: 'GITHUB' | 'GITLAB', event: string, payload: Json, log: FastifyBaseLogger) {
  const project = payload.project as Json | undefined;
  const repository = payload.repository as Json | undefined;
  const owner =
    provider === 'GITLAB'
      ? text(project?.path_with_namespace)
      : (text((payload.organization as Json | undefined)?.login) ?? text((repository?.owner as Json | undefined)?.login));
  // GitHub's first delivery ("ping") and events without an owner only confirm the hook works.
  const boards = owner
    ? (await prisma.taskBoard.findMany({ where: { provider } })).filter((board) =>
        provider === 'GITLAB'
          ? owner.toLowerCase().startsWith(`${board.ownerPath.toLowerCase()}/`)
          : owner.toLowerCase() === board.ownerPath.toLowerCase(),
      )
    : [];
  if (boards.length > 0) {
    await prisma.taskBoard.updateMany({ where: { id: { in: boards.map((board) => board.id) } }, data: { lastSyncedAt: null } });
    const workspaceIds = [...new Set(boards.map((board) => board.workspaceId))];
    for (const workspaceId of workspaceIds) syncWorkspaceSoon(workspaceId, log);
    void commentLessonsOnOpen(provider, payload, workspaceIds, log).catch((error) => log.warn({ err: error }, 'lições no PR/MR'));
  }
  await saveLastDelivery({ at: new Date().toISOString(), provider, event, owner, boards: boards.length });
  return { boards: boards.length };
}
