import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parseInput } from '../../lib/validation.js';
import { listActivity, resolveFlag } from './activity.js';
import { overview, ownerWorkspaces, pendingItems } from './ops.js';
import { getPilot, updatePilot } from './pilot.js';

const idParams = z.object({ id: z.uuid() });
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
const pilotBody = z
  .object({
    enabled: z.boolean().optional(),
    allWorkspaces: z.boolean().optional(),
    workspaceIds: z.array(z.uuid()).max(100).optional(),
    model: z.enum(['sonnet', 'opus']).optional(),
    instructions: z.string().max(4000).optional(),
  })
  .strict();

export async function orbiRoutes(app: FastifyInstance) {
  app.get('/orbi/overview', async (request) => overview(request.user.id));

  /** What waits for the user (or for the pilot): agent questions, failed runs, suggestions, Órbi's proposals and flags. */
  app.get('/orbi/pending', async (request) => {
    const workspaces = await ownerWorkspaces(request.user.id);
    const ids = workspaces.map((workspace) => workspace.id);
    const [pending, proposals] = await Promise.all([
      pendingItems(request.user.id, ids),
      prisma.assistantProposal.findMany({
        where: { status: 'PENDING', workspaceId: { in: ids }, agent: { kind: 'ASSISTANT' } },
        select: { id: true, summary: true, kind: true, agentId: true, workspaceId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { ...pending, proposals, workspaces };
  });

  app.get('/orbi/activity', async (request) => listActivity(request.user.id, parseInput(activityQuery, request.query).limit));

  app.post('/orbi/flags/:id/resolve', async (request) => resolveFlag(request.user.id, parseInput(idParams, request.params).id));

  app.get('/orbi/pilot', async (request) => getPilot(request.user.id));

  app.put('/orbi/pilot', async (request) => updatePilot(request.user.id, parseInput(pilotBody, request.body)));
}
