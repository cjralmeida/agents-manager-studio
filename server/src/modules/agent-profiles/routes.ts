import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput, patchSchema } from '../../lib/validation.js';
import { profileSchema } from './schema.js';
import {
  createAgentProfile,
  deleteAgentProfile,
  listAgentProfiles,
  listAllAgentProfiles,
  updateAgentProfile,
} from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const profileBody = profileSchema;

export async function agentProfileRoutes(app: FastifyInstance) {
  app.get('/agent-profiles', async (request) => listAllAgentProfiles(request.user.id));

  app.get('/workspaces/:id/agent-profiles', async (request) => listAgentProfiles(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/agent-profiles', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await createAgentProfile(id, parseInput(profileBody, request.body)));
  });

  app.patch('/agent-profiles/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateAgentProfile(id, parseInput(patchSchema(profileBody), request.body));
  });

  app.delete('/agent-profiles/:id', async (request, reply) => {
    await deleteAgentProfile(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
