import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { workspaceRoadmaps } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const roadmapQuery = z.object({ refresh: z.stringbool().default(false) }).strict();

export async function roadmapRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/roadmaps', async (request) =>
    workspaceRoadmaps(parseInput(workspaceParams, request.params).id, parseInput(roadmapQuery, request.query).refresh),
  );
}
