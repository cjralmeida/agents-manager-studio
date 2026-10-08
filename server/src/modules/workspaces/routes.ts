import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import {
  createWorkspace,
  deleteMissingWorkspace,
  getWorkspace,
  listWorkspaces,
  scanWorkspaces,
  setWorkspaceIgnored,
} from './service.js';

const listQuery = z
  .object({ includeIgnored: z.enum(['true', 'false']).default('false') })
  .strict()
  .transform((query) => ({ includeIgnored: query.includeIgnored === 'true' }));

const createBody = z.object({ name: z.string().max(200) }).strict();

const idParams = z.object({ id: z.uuid() });

const updateBody = z.object({ isIgnored: z.boolean() }).strict();

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/workspaces', async (request) => listWorkspaces(parseInput(listQuery, request.query)));

  app.post('/workspaces/scan', async () => scanWorkspaces());

  /** Creates a new workspace folder in the central folder. */
  app.post('/workspaces', async (request, reply) => {
    const { name } = parseInput(createBody, request.body);
    return reply.code(201).send(await createWorkspace(name));
  });

  app.get('/workspaces/:id', async (request) => getWorkspace(parseInput(idParams, request.params).id));

  app.patch('/workspaces/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { isIgnored } = parseInput(updateBody, request.body);
    return setWorkspaceIgnored(id, isIgnored);
  });

  app.delete('/workspaces/:id', async (request, reply) => {
    await deleteMissingWorkspace(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
