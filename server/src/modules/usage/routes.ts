import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getUsageSummary } from './service.js';

/** Without workspaceId: every workspace; with it: only that workspace's agents. */
const summaryQuery = z.object({ workspaceId: z.uuid().optional() }).strict();

export async function usageRoutes(app: FastifyInstance) {
  app.get('/usage/summary', async (request) => getUsageSummary(parseInput(summaryQuery, request.query).workspaceId));
}
