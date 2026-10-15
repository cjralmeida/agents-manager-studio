import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { capacitySummary, decideCapacitySuggestion, pendingCapacitySuggestions } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const decisionParams = z.object({ id: z.uuid(), decision: z.enum(['apply', 'discard']) });

export async function capacityRoutes(app: FastifyInstance) {
  app.get('/capacity/suggestions', async (request) => pendingCapacitySuggestions(request.user.id));

  app.post('/capacity/suggestions/:id/:decision', async (request) => {
    const { id, decision } = parseInput(decisionParams, request.params);
    return decideCapacitySuggestion(request.user.id, id, decision);
  });

  app.get('/workspaces/:id/capacity', async (request) => capacitySummary(parseInput(workspaceParams, request.params).id));
}
