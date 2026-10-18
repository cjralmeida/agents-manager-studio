import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { ATTACHMENTS_BODY_LIMIT, attachmentsSchema } from './attachments.js';
import { decideProposal, listProposals } from './proposals.js';
import { continueConversation, listConversations, renameConversation, startConversation } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const messageBody = z
  .object({
    /** May be empty when there are attachments. */
    message: z.string().trim().max(20_000),
    /** The page the user is on (e.g. "workflow Bugs do app"), added to the message for Órbi. */
    context: z.string().trim().max(500).optional(),
    /** Images and audios, saved in the conversation's folder. */
    attachments: attachmentsSchema.optional(),
  })
  .strict();

export async function assistantRoutes(app: FastifyInstance) {
  app.get('/assistant/conversations', async (request) => listConversations(request.user.id));

  app.post('/workspaces/:id/assistant/conversations', { bodyLimit: ATTACHMENTS_BODY_LIMIT }, async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    const { message, context, attachments } = parseInput(messageBody, request.body);
    return reply.code(201).send(await startConversation(id, message, context, { attachments }));
  });

  app.post('/assistant/conversations/:id/messages', { bodyLimit: ATTACHMENTS_BODY_LIMIT }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { message, context, attachments } = parseInput(messageBody, request.body);
    return continueConversation(id, message, context, attachments);
  });

  app.patch('/assistant/conversations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { title } = parseInput(z.object({ title: z.string().trim().min(1).max(120) }).strict(), request.body);
    return renameConversation(request.user.id, id, title);
  });

  app.get('/assistant/conversations/:id/proposals', async (request) => listProposals(parseInput(idParams, request.params).id));

  app.post('/assistant/proposals/:id/apply', async (request) => decideProposal(parseInput(idParams, request.params).id, 'apply'));

  app.post('/assistant/proposals/:id/discard', async (request) => decideProposal(parseInput(idParams, request.params).id, 'discard'));
}
