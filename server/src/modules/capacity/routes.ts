import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { capacitySummary, pendingCapacitySuggestions } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });

export async function capacityRoutes(app: FastifyInstance) {
  app.get('/capacity/suggestions', async (request) => pendingCapacitySuggestions(request.user.id));

  app.get('/workspaces/:id/capacity', async (request) => capacitySummary(parseInput(workspaceParams, request.params).id));
}
