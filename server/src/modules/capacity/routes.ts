import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { capacitySummary } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });

export async function capacityRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/capacity', async (request) => capacitySummary(parseInput(workspaceParams, request.params).id));
}
