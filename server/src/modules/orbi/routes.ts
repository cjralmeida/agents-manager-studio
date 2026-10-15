import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { parseInput } from '../../lib/validation.js';
import { listActivity, resolveFlag } from './activity.js';
import { overview, ownerWorkspaces, pendingItems } from './ops.js';
import { getPilot, updatePilot } from './pilot.js';

const idParams = z.object({ id: z.uuid() });
const seenBody = z.object({ runIds: z.array(z.uuid()).max(200).optional() }).strict();

/** Failed runs the user already saw: everything up to a moment ("marcar tudo como visto") plus single ones. */
const SEEN_KEY = 'orbiSeen';
interface Seen {
  failuresUntil: string | null;
  runIds: string[];
}
const SEEN_RUNS_KEPT = 300;

async function seenOf(userId: string): Promise<Seen> {
  return { failuresUntil: null, runIds: [], ...((await getUserSetting<Partial<Seen>>(userId, SEEN_KEY)) ?? {}) };
}
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
const pilotBody = z
  .object({
    enabled: z.boolean().optional(),
    allWorkspaces: z.boolean().optional(),
    workspaceIds: z.array(z.uuid()).max(100).optional(),
    model: z.enum(['sonnet', 'opus']).optional(),
    mode: z.enum(['technical', 'full']).optional(),
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
    // What the user marked as seen leaves their list (the pilot still gets every failure).
    const seen = await seenOf(request.user.id);
    const until = seen.failuresUntil ? new Date(seen.failuresUntil) : null;
    const failedRuns = pending.failedRuns.filter((run) => !seen.runIds.includes(run.runId) && (!until || new Date(run.finishedAt!) > until));
    return { ...pending, failedRuns, proposals, workspaces };
  });

  /** Marks failures as seen: the given runs, or (without runIds) everything up to now, open flags included. */
  app.post('/orbi/pending/seen', async (request) => {
    const { runIds } = parseInput(seenBody, request.body ?? {});
    const seen = await seenOf(request.user.id);
    if (runIds?.length) {
      seen.runIds = [...new Set([...runIds, ...seen.runIds])].slice(0, SEEN_RUNS_KEPT);
    } else {
      seen.failuresUntil = new Date().toISOString();
      seen.runIds = [];
      await prisma.orbiActivity.updateMany({ where: { ownerId: request.user.id, kind: 'flag', resolvedAt: null }, data: { resolvedAt: new Date() } });
    }
    await setUserSetting(request.user.id, SEEN_KEY, seen);
    return seen;
  });

  app.get('/orbi/activity', async (request) => listActivity(request.user.id, parseInput(activityQuery, request.query).limit));

  app.post('/orbi/flags/:id/resolve', async (request) => resolveFlag(request.user.id, parseInput(idParams, request.params).id));

  app.get('/orbi/pilot', async (request) => getPilot(request.user.id));

  app.put('/orbi/pilot', async (request) => updatePilot(request.user.id, parseInput(pilotBody, request.body)));
}
