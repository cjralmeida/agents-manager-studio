import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getTestEnv, listTestEnvs, startTestEnv, stopTestEnv, testEnvCapacity } from './service.js';

const idParams = z.object({ id: z.uuid() });
const startBody = z.object({ project: z.string().trim().min(1).max(100), variables: z.record(z.string(), z.string()).optional() }).strict();

export async function testEnvRoutes(app: FastifyInstance) {
  /** Test environments going up or running, and how many more fit on the computer now. */
  app.get('/test-envs', async () => ({ environments: await listTestEnvs({ active: true }), capacity: await testEnvCapacity() }));

  /** Starts (or queues) a test environment of a workspace project by hand. */
  app.post('/workspaces/:id/test-envs', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(startBody, request.body);
    return reply.code(201).send(await startTestEnv({ workspaceId: id, projectName: body.project, agentId: null, variables: body.variables }, request.log));
  });

  app.get('/test-envs/:id', async (request) => getTestEnv(parseInput(idParams, request.params).id));

  app.post('/test-envs/:id/stop', async (request) => stopTestEnv(parseInput(idParams, request.params).id));
}
