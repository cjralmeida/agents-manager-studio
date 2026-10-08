import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { parseInput } from '../../lib/validation.js';
import { AGENT_MODELS } from '../agents/service.js';
import { syncAndWatch } from './scheduler.js';
import { createSentinel, deleteSentinel, findOrThrow, getSentinel, listSentinels, updateSentinel } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const sentinelBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    isEnabled: z.boolean().default(true),
    fieldFilters: z.record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(50)).default({}),
    repositories: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
    columnId: z.string().min(1).max(200).nullable().default(null),
    onlyUnassigned: z.boolean().default(true),
    instructions: z.string().max(10_000).default(''),
    model: z.enum(AGENT_MODELS).default('sonnet'),
    maxConcurrent: z.number().int().min(1).max(5).default(1),
  })
  .strict();

export async function sentinelRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/sentinels', async (request) => listSentinels(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/sentinels', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await createSentinel(id, parseInput(sentinelBody, request.body)));
  });

  app.patch('/sentinels/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateSentinel(id, parseInput(sentinelBody.partial(), request.body));
  });

  app.delete('/sentinels/:id', async (request, reply) => {
    await deleteSentinel(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });

  /** Reads the board now and evaluates this sentinel right away. */
  app.post('/sentinels/:id/run', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const sentinel = await findOrThrow(id);
    if (!sentinel.isEnabled) throw new HttpError(409, 'Ative a sentinela antes de verificar.');
    await syncAndWatch(sentinel.workspaceId, request.log, id);
    return getSentinel(id);
  });
}
