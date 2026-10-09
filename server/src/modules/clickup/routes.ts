import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { createClickupAccount, deleteClickupAccount, listClickupAccounts, updateClickupAccount, verifyClickupAccount } from './service.js';

const idParams = z.object({ id: z.uuid() });
const token = z.string().transform((value) => value.replace(/\s+/g, '')).pipe(z.string().min(10).max(500));
const accountBody = z.object({ label: z.string().trim().min(1).max(80), token }).strict();
const accountUpdateBody = z.object({ label: z.string().trim().min(1).max(80).optional(), token: token.optional() }).strict();

/** ClickUp accounts (personal API tokens); agents only read tasks through them. */
export async function clickupRoutes(app: FastifyInstance) {
  app.get('/clickup-accounts', async (request) => listClickupAccounts(request.user.id));

  app.post('/clickup-accounts', async (request, reply) =>
    reply.code(201).send(await createClickupAccount(request.user.id, parseInput(accountBody, request.body))),
  );

  app.patch('/clickup-accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateClickupAccount(id, parseInput(accountUpdateBody, request.body));
  });

  app.post('/clickup-accounts/:id/verify', async (request) => verifyClickupAccount(parseInput(idParams, request.params).id));

  app.delete('/clickup-accounts/:id', async (request, reply) => {
    await deleteClickupAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
