import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { createAgentAccount, deleteAgentAccount, listAgentAccounts, updateAgentAccount } from './service.js';

const idParams = z.object({ id: z.uuid() });

const label = z.string().trim().min(1).max(80);
// Token printed by `claude setup-token`.
const token = z
  .string()
  .trim()
  .min(20)
  .max(500)
  .startsWith('sk-ant-', 'O token deve começar com "sk-ant-" (gere com `claude setup-token`).');

const createBody = z.object({ label, token }).strict();

const updateBody = z
  .object({ label: label.optional(), token: token.optional() })
  .strict()
  .refine((body) => body.label !== undefined || body.token !== undefined, 'Informe o nome ou um novo token.');

export async function agentAccountRoutes(app: FastifyInstance) {
  app.get('/agent-accounts', async () => listAgentAccounts());

  app.post('/agent-accounts', async (request, reply) => {
    const account = await createAgentAccount(parseInput(createBody, request.body));
    return reply.code(201).send(account);
  });

  app.patch('/agent-accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateAgentAccount(id, parseInput(updateBody, request.body));
  });

  app.delete('/agent-accounts/:id', async (request, reply) => {
    await deleteAgentAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
