import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { parseInput } from '../../lib/validation.js';
import { requireAdmin } from '../auth/guard.js';
import { ensureAllBoardWebhooks } from './hooks.js';
import { receiveDelivery, verifyGitHub, verifyGitLab } from './receive.js';
import { boardWebhookState, lastDelivery, receiverUrl, savePublicUrl, webhookConfig } from './settings.js';

const publicUrlBody = z
  .object({
    publicUrl: z
      .string()
      .trim()
      .max(300)
      .regex(/^https:\/\/[^\s/]+\/?$/, 'Informe só o endereço https, como https://webhooks.seudominio.com.')
      .nullable(),
  })
  .strict();

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  // GitHub signs the body exactly as sent: keep it before parsing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Public (no session): checked by the secret. Answered at once; the board is read in the background.
  app.post('/webhooks/gitlab', async (request, reply) => {
    await verifyGitLab(request.headers['x-gitlab-token'] as string | undefined);
    const event = String(request.headers['x-gitlab-event'] ?? '');
    reply.code(202);
    return receiveDelivery('GITLAB', event, (request.body ?? {}) as Record<string, unknown>, request.log);
  });

  app.post('/webhooks/github', async (request, reply) => {
    await verifyGitHub(request.headers['x-hub-signature-256'] as string | undefined, request.rawBody ?? '');
    const event = String(request.headers['x-github-event'] ?? '');
    reply.code(202);
    return receiveDelivery('GITHUB', event, (request.body ?? {}) as Record<string, unknown>, request.log);
  });

  /** The public address, the receiver urls, the last delivery and each board's hook (administrators). */
  app.get('/webhooks', async (request) => {
    requireAdmin(request);
    const { publicUrl } = await webhookConfig();
    const boards = await prisma.taskBoard.findMany({
      where: { provider: { not: 'STUDIO' } },
      select: { id: true, title: true, provider: true, ownerPath: true, url: true, workspace: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      publicUrl,
      receivers: publicUrl ? { gitlab: receiverUrl(publicUrl, 'GITLAB'), github: receiverUrl(publicUrl, 'GITHUB') } : null,
      lastDelivery: await lastDelivery(),
      boards: await Promise.all(
        boards.map(async (board) => ({
          id: board.id,
          title: board.title,
          provider: board.provider,
          ownerPath: board.ownerPath,
          url: board.url,
          workspace: board.workspace.name,
          webhook: await boardWebhookState(board.id),
        })),
      ),
    };
  });

  /** Saving the address sets up the hook of every linked board (new boards get theirs when linked). */
  app.put('/webhooks', async (request) => {
    requireAdmin(request);
    const { publicUrl } = parseInput(publicUrlBody, request.body);
    await savePublicUrl(publicUrl?.replace(/\/+$/, '') ?? null);
    if (publicUrl) await ensureAllBoardWebhooks();
    return { ok: true };
  });

  app.post('/webhooks/setup', async (request) => {
    requireAdmin(request);
    if (!(await webhookConfig()).publicUrl) throw new HttpError(422, 'Salve primeiro o endereço público do túnel.');
    await ensureAllBoardWebhooks();
    return { ok: true };
  });
}
