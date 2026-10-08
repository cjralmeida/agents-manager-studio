import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { syncBoard } from '../boards/service.js';
import { advanceAllRuns, runBoardTriggers } from './engine.js';

/** How often boards due for a refresh are looked for (each board has its own interval). */
const BOARD_TICK_MS = 15_000;
/** How often running workflow runs are moved forward. */
const RUNS_TICK_MS = 10_000;
const syncing = new Set<string>();

/** Reads one board from the provider and runs the board triggers of its workspace; never throws. */
async function syncAndTrigger(workspaceId: string, log: FastifyBaseLogger) {
  if (syncing.has(workspaceId)) return;
  syncing.add(workspaceId);
  try {
    const board = await prisma.taskBoard.findUnique({ where: { workspaceId } });
    if (!board) return;
    await syncBoard(board);
    await runBoardTriggers(workspaceId, log);
  } catch (err) {
    log.warn({ workspaceId, err }, 'Board sync failed');
  } finally {
    syncing.delete(workspaceId);
  }
}

async function boardTick(log: FastifyBaseLogger) {
  const boards = await prisma.taskBoard.findMany({
    where: { workspace: { isIgnored: false, missingAt: null } },
    select: { workspaceId: true, refreshIntervalSec: true, lastSyncedAt: true },
  });
  const now = Date.now();
  for (const board of boards) {
    const due = !board.lastSyncedAt || now - board.lastSyncedAt.getTime() >= board.refreshIntervalSec * 1000;
    // One board after another, to spread the provider calls.
    if (due) await syncAndTrigger(board.workspaceId, log);
  }
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
 * Keeps the boards fresh, starts workflows from board tasks and moves running workflows forward.
 * Started with the server, and everything lives in the database, so it all resumes after a restart.
 */
export function startWorkflowScheduler(log: FastifyBaseLogger) {
  const stopBoards = loop('Board scheduler', BOARD_TICK_MS, () => boardTick(log), log);
  const stopRuns = loop('Workflow runs', RUNS_TICK_MS, () => advanceAllRuns(log), log);
  return () => {
    stopBoards();
    stopRuns();
  };
}
