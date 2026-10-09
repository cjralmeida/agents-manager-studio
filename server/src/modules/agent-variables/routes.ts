import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { deleteAgentVariable, listAgentVariables, setAgentVariable } from './service.js';

const idParams = z.object({ id: z.uuid() });
const keyParams = z.object({ id: z.uuid(), key: z.string().min(1).max(64) });
const valueBody = z.object({ value: z.string().min(1).max(10_000) }).strict();

/** Variables a workspace's agents can read (values are write-only here: the API returns only a hint). */
export async function agentVariableRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/agent-variables', async (request) => listAgentVariables(parseInput(idParams, request.params).id));

  app.put('/workspaces/:id/agent-variables/:key', async (request) => {
    const { id, key } = parseInput(keyParams, request.params);
    return setAgentVariable(id, key, parseInput(valueBody, request.body).value);
  });

  app.delete('/workspaces/:id/agent-variables/:key', async (request) => {
    const { id, key } = parseInput(keyParams, request.params);
    return deleteAgentVariable(id, key);
  });
}
