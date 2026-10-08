import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { decideProposal, listProposals } from './proposals.js';
import { continueConversation, listConversations, startConversation } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const messageBody = z
  .object({
    message: z.string().trim().min(1).max(20_000),
    /** The page the user is on (e.g. "workflow Bugs do app"), added to the message for Órbi. */
    context: z.string().trim().max(500).optional(),
  })
  .strict();

export async function assistantRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/assistant/conversations', async (request) => listConversations(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/assistant/conversations', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    const { message, context } = parseInput(messageBody, request.body);
    return reply.code(201).send(await startConversation(id, message, context));
  });

  app.post('/assistant/conversations/:id/messages', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { message, context } = parseInput(messageBody, request.body);
    return continueConversation(id, message, context);
  });

  app.get('/assistant/conversations/:id/proposals', async (request) => listProposals(parseInput(idParams, request.params).id));

  app.post('/assistant/proposals/:id/apply', async (request) => decideProposal(parseInput(idParams, request.params).id, 'apply'));

  app.post('/assistant/proposals/:id/discard', async (request) => decideProposal(parseInput(idParams, request.params).id, 'discard'));
}
