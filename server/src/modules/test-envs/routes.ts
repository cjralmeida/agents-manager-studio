import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { listTestEnvs, stopTestEnv, testEnvCapacity } from './service.js';

const idParams = z.object({ id: z.uuid() });

export async function testEnvRoutes(app: FastifyInstance) {
  /** Test environments going up or running, and how many more fit on the computer now. */
  app.get('/test-envs', async () => ({ environments: await listTestEnvs({ active: true }), capacity: await testEnvCapacity() }));

  app.post('/test-envs/:id/stop', async (request) => stopTestEnv(parseInput(idParams, request.params).id));
}
