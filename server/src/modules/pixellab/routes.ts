import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { createPixellabAccount, deletePixellabAccount, listPixellabAccounts, updatePixellabAccount, verifyPixellabAccount } from './service.js';

const idParams = z.object({ id: z.uuid() });
const token = z.string().transform((value) => value.replace(/\s+/g, '')).pipe(z.string().min(10).max(500));
const accountBody = z.object({ label: z.string().trim().min(1).max(80), token }).strict();
const accountUpdateBody = z.object({ label: z.string().trim().min(1).max(80).optional(), token: token.optional() }).strict();

/** PixelLab accounts (API tokens) for pixel art generation by agents. */
export async function pixellabRoutes(app: FastifyInstance) {
  app.get('/pixellab-accounts', async (request) => listPixellabAccounts(request.user.id));

  app.post('/pixellab-accounts', async (request, reply) =>
    reply.code(201).send(await createPixellabAccount(request.user.id, parseInput(accountBody, request.body))),
  );

  app.patch('/pixellab-accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updatePixellabAccount(id, parseInput(accountUpdateBody, request.body));
  });

  app.post('/pixellab-accounts/:id/verify', async (request) => verifyPixellabAccount(parseInput(idParams, request.params).id));

  app.delete('/pixellab-accounts/:id', async (request, reply) => {
    await deletePixellabAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
