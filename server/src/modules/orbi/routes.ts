import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { parseInput } from '../../lib/validation.js';
import { ATTACHMENTS_BODY_LIMIT, attachmentsSchema } from '../assistant/attachments.js';
import { decideFlag, listActivity, resolveFlag } from './activity.js';
import { conversationInfo, restartConversation, sendToOrbi, setOrbiModel } from './conversation.js';
import { overview, ownerWorkspaces, pendingItems } from './ops.js';
import { ROUTINE_EVENTS, type RoutineEvent, createRoutine, deleteRoutine, listRoutines, runRoutineNow, updateRoutine } from './routines.js';

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

const messageBody = z
  .object({
    /** May be empty when there are attachments. */
    message: z.string().trim().max(20_000),
    /** The page the user is on (e.g. "workflow Bugs do app"), added to the message for Órbi. */
    context: z.string().trim().max(500).optional(),
    /** Where a brand-new conversation starts (the workspace on screen). */
    workspaceId: z.uuid().optional(),
    attachments: attachmentsSchema.optional(),
  })
  .strict();

const eventNames = Object.keys(ROUTINE_EVENTS) as [RoutineEvent, ...RoutineEvent[]];
const routineBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().max(8000),
    workspaceIds: z.array(z.uuid()).max(100),
    everyMinutes: z.number().int().min(5).max(24 * 60).nullable(),
    dailyAt: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:MM.')).max(12),
    events: z.array(z.enum(eventNames)).max(eventNames.length),
    mode: z.enum(['auto', 'assistant']),
    enabled: z.boolean(),
  })
  .strict();

const decideBody = z.object({ option: z.string().trim().max(200).optional(), note: z.string().trim().max(4000).optional() }).strict();

export async function orbiRoutes(app: FastifyInstance) {
  app.get('/orbi/overview', async (request) => overview(request.user.id));

  // ---------------------------------------------------------------- the one conversation

  app.get('/orbi/conversation', async (request) => conversationInfo(request.user.id));

  app.post('/orbi/conversation/messages', { bodyLimit: ATTACHMENTS_BODY_LIMIT }, async (request) =>
    sendToOrbi(request.user.id, parseInput(messageBody, request.body)),
  );

  app.put('/orbi/conversation/model', async (request) =>
    setOrbiModel(request.user.id, parseInput(z.object({ model: z.enum(['sonnet', 'opus']) }).strict(), request.body).model),
  );

  app.post('/orbi/conversation/restart', async (request) => restartConversation(request.user.id));

  // ---------------------------------------------------------------- routines

  app.get('/orbi/routines', async (request) => ({ routines: await listRoutines(request.user.id), events: ROUTINE_EVENTS }));

  app.post('/orbi/routines', async (request, reply) => reply.code(201).send(await createRoutine(request.user.id, parseInput(routineBody, request.body))));

  app.patch('/orbi/routines/:id', async (request) =>
    updateRoutine(request.user.id, parseInput(idParams, request.params).id, parseInput(routineBody.partial(), request.body)),
  );

  app.delete('/orbi/routines/:id', async (request, reply) => {
    await deleteRoutine(request.user.id, parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });

  app.post('/orbi/routines/:id/run', async (request) => runRoutineNow(request.user.id, parseInput(idParams, request.params).id));

  // ---------------------------------------------------------------- decisions and activity

  /** What waits for the user: Órbi's decisions, agent questions, failed runs, capacity suggestions, proposals. */
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
    // What the user marked as seen leaves their list (routines still get every failure).
    const seen = await seenOf(request.user.id);
    const until = seen.failuresUntil ? new Date(seen.failuresUntil) : null;
    const failedRuns = pending.failedRuns.filter((run) => !seen.runIds.includes(run.runId) && (!until || new Date(run.finishedAt!) > until));
    return { ...pending, failedRuns, proposals, workspaces };
  });

  /** Marks failures as seen: the given runs, or (without runIds) everything up to now. */
  app.post('/orbi/pending/seen', async (request) => {
    const { runIds } = parseInput(seenBody, request.body ?? {});
    const seen = await seenOf(request.user.id);
    if (runIds?.length) {
      seen.runIds = [...new Set([...runIds, ...seen.runIds])].slice(0, SEEN_RUNS_KEPT);
    } else {
      seen.failuresUntil = new Date().toISOString();
      seen.runIds = [];
    }
    await setUserSetting(request.user.id, SEEN_KEY, seen);
    return seen;
  });

  app.get('/orbi/activity', async (request) => listActivity(request.user.id, parseInput(activityQuery, request.query).limit));

  app.post('/orbi/flags/:id/decide', async (request) => decideFlag(request.user.id, parseInput(idParams, request.params).id, parseInput(decideBody, request.body ?? {})));

  app.post('/orbi/flags/:id/resolve', async (request) => resolveFlag(request.user.id, parseInput(idParams, request.params).id));
}
