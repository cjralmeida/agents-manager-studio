import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { AGENT_MODELS } from '../agents/service.js';
import {
  PROFILE_TOOLS,
  createAgentProfile,
  deleteAgentProfile,
  listAgentProfiles,
  listAllAgentProfiles,
  updateAgentProfile,
} from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    instructions: z.string().max(20_000).default(''),
    model: z.enum(AGENT_MODELS).default('sonnet'),
    projectIds: z.array(z.uuid()).max(50).default([]),
    output: z.enum(['PULL_REQUEST', 'RESULT']).default('PULL_REQUEST'),
    tools: z.array(z.enum(PROFILE_TOOLS)).default([]),
    autoConclude: z.boolean().default(false),
  })
  .strict();

export async function agentProfileRoutes(app: FastifyInstance) {
  app.get('/agent-profiles', async () => listAllAgentProfiles());

  app.get('/workspaces/:id/agent-profiles', async (request) => listAgentProfiles(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/agent-profiles', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await createAgentProfile(id, parseInput(profileBody, request.body)));
  });

  app.patch('/agent-profiles/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateAgentProfile(id, parseInput(profileBody.partial(), request.body));
  });

  app.delete('/agent-profiles/:id', async (request, reply) => {
    await deleteAgentProfile(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
