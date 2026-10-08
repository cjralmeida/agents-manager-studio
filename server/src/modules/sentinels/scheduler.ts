import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { syncBoard } from '../boards/service.js';
import { runSentinels } from './engine.js';

/** How often the scheduler looks for boards due for a refresh (each board has its own interval). */
const TICK_MS = 15_000;
const running = new Set<string>();

/** Reads one board from the provider and runs the sentinels of its workspace; never throws. */
export async function syncAndWatch(workspaceId: string, log: FastifyBaseLogger, onlySentinelId?: string) {
  if (running.has(workspaceId)) return;
  running.add(workspaceId);
  try {
    const board = await prisma.taskBoard.findUnique({ where: { workspaceId } });
    if (!board) return;
    await syncBoard(board);
    await runSentinels(workspaceId, log, onlySentinelId);
  } catch (err) {
    log.warn({ workspaceId, err }, 'Board sync failed');
  } finally {
    running.delete(workspaceId);
  }
}

async function tick(log: FastifyBaseLogger) {
  const boards = await prisma.taskBoard.findMany({
    where: { workspace: { isIgnored: false, missingAt: null } },
    select: { workspaceId: true, refreshIntervalSec: true, lastSyncedAt: true },
  });
  const now = Date.now();
  for (const board of boards) {
    const due = !board.lastSyncedAt || now - board.lastSyncedAt.getTime() >= board.refreshIntervalSec * 1000;
    // Boards are synced one after another to spread the provider calls.
    if (due) await syncAndWatch(board.workspaceId, log);
  }
}

/**
 * Keeps every linked board fresh and runs the sentinels after each refresh. Started with the server,
 * so sentinels resume by themselves after the Studio restarts (their configuration lives in the database).
 */
export function startBoardScheduler(log: FastifyBaseLogger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async () => {
    try {
      await tick(log);
    } catch (err) {
      log.error({ err }, 'Board scheduler tick failed');
    }
    if (!stopped) timer = setTimeout(loop, TICK_MS);
  };
  void loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
