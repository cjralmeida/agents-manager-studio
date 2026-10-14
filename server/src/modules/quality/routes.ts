import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { QUALITY_STATUSES, listQuality, logOccurrence, updateCategory } from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const categoryParams = z.object({ id: z.uuid(), categoryId: z.uuid() });
const updateBody = z
  .object({
    status: z.enum(QUALITY_STATUSES).optional(),
    transversalRef: z.string().trim().max(300).nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const occurrenceBody = z
  .object({
    category: z.string().trim().min(1).max(200),
    task: z.string().trim().min(1).max(300),
    expected: z.string().trim().min(1).max(2000),
    obtained: z.string().trim().min(1).max(2000),
  })
  .strict();

export async function qualityRoutes(app: FastifyInstance) {
  /** The recurring defects of a workspace, by category, with their occurrences. */
  app.get('/workspaces/:id/quality', async (request) => listQuality(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/quality/occurrences', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await logOccurrence(id, { ...parseInput(occurrenceBody, request.body), reviewer: 'usuário' }));
  });

  app.patch('/workspaces/:id/quality/categories/:categoryId', async (request) => {
    const { id, categoryId } = parseInput(categoryParams, request.params);
    return updateCategory(id, { id: categoryId, ...parseInput(updateBody, request.body) });
  });
}
