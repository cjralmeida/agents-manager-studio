import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { syncWorkspaceBoard } from '../boards/service.js';
import { advanceAllRuns, runBoardTriggers } from './engine.js';
import { runSchedules } from './schedule.js';

/** How often boards due for a refresh are looked for (each board has its own interval). */
const BOARD_TICK_MS = 15_000;
/** How often running workflow runs are moved forward. */
const RUNS_TICK_MS = 10_000;
/** How often scheduled workflows are checked. */
const SCHEDULE_TICK_MS = 60_000;
const syncing = new Set<string>();
/** When the board triggers last ran per workspace (a board refreshed from the UI is not synced here again). */
const lastTriggers = new Map<string, number>();

/** Reads the workspace's sources that are due and runs the board triggers of the workspace; never throws. */
async function syncAndTrigger(workspaceId: string, log: FastifyBaseLogger, triggerAnyway = false) {
  if (syncing.has(workspaceId)) return;
  syncing.add(workspaceId);
  try {
    const { synced, errors } = await syncWorkspaceBoard(workspaceId, true);
    if (errors.length > 0) log.warn({ workspaceId, errors }, 'Board source sync failed');
    if (synced > 0 || triggerAnyway) {
      lastTriggers.set(workspaceId, Date.now());
      await runBoardTriggers(workspaceId, log);
    }
  } catch (err) {
    log.warn({ workspaceId, err }, 'Board sync failed');
  } finally {
    syncing.delete(workspaceId);
  }
}

const soon = new Map<string, NodeJS.Timeout>();

/**
 * A webhook said the workspace's board changed: it is read again in a few seconds (a burst of deliveries, like a task
 * moved and labeled, becomes one read) and the board triggers run.
 */
export function syncWorkspaceSoon(workspaceId: string, log: FastifyBaseLogger) {
  if (soon.has(workspaceId)) return;
  soon.set(
    workspaceId,
    setTimeout(() => {
      soon.delete(workspaceId);
      void syncAndTrigger(workspaceId, log, true);
    }, 3_000),
  );
}

async function boardTick(log: FastifyBaseLogger) {
  const boards = await prisma.taskBoard.findMany({
    where: { workspace: { isIgnored: false, missingAt: null } },
    select: { workspaceId: true, refreshIntervalSec: true, lastSyncedAt: true },
  });
  const now = Date.now();
  const due = new Set(
    boards.filter((board) => !board.lastSyncedAt || now - board.lastSyncedAt.getTime() >= board.refreshIntervalSec * 1000).map((board) => board.workspaceId),
  );
  // A board refreshed from the UI (or another caller) is not due here, but its triggers must still run on schedule:
  // otherwise an open board page keeps the workflows from taking new tasks.
  const triggersDue = new Set(
    boards.filter((board) => now - (lastTriggers.get(board.workspaceId) ?? 0) >= board.refreshIntervalSec * 1000).map((board) => board.workspaceId),
  );
  // One workspace after another, to spread the provider calls.
  for (const workspaceId of new Set([...due, ...triggersDue])) await syncAndTrigger(workspaceId, log, triggersDue.has(workspaceId));
}

function loop(name: string, intervalMs: number, work: () => Promise<void>, log: FastifyBaseLogger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    try {
      await work();
    } catch (err) {
      log.error({ err }, `${name} failed`);
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Keeps the boards fresh, starts workflows from board tasks and on their schedules, and moves running workflows forward.
 * Started with the server, and everything lives in the database, so it all resumes after a restart.
 */
export function startWorkflowScheduler(log: FastifyBaseLogger) {
  const stopBoards = loop('Board scheduler', BOARD_TICK_MS, () => boardTick(log), log);
  const stopRuns = loop('Workflow runs', RUNS_TICK_MS, () => advanceAllRuns(log), log);
  const stopSchedules = loop('Workflow schedules', SCHEDULE_TICK_MS, () => runSchedules(log), log);
  return () => {
    stopBoards();
    stopRuns();
    stopSchedules();
  };
}
