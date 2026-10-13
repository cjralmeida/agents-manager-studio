import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { isVolumeCopy, mirrorPath, VOLUME_PREFIX, workdirPath } from './workdir.js';

/**
 * Copies in the Docker volume are invisible from Windows. When every agent using a copy has stopped (its turn ended,
 * it concluded or failed), the code (without .git and the build folders) is copied to the Windows folder, so the user
 * finds it in D:\AgentsWorktrees as before. Copying to the slow disk runs in the background, one copy at a time.
 */

const TICK_MS = 60_000;
/** Big and regenerable: the history is in the branch/PR, the rest comes back with an install or a build. */
const SKIPPED = new Set(['.git', 'node_modules', 'target', '.gradle', '.venv']);
const STOPPED = ['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED'];

/** Copies needing a fresh mirror: all their agents stopped, and something happened since the last mirror. */
async function pendingCopies() {
  const agents = await prisma.agent.findMany({
    where: { workdir: { startsWith: VOLUME_PREFIX }, workdirRemovedAt: null },
    select: { id: true, workdir: true, status: true, containerId: true, lastActivityAt: true, mirroredAt: true },
  });
  const byCopy = new Map<string, typeof agents>();
  for (const agent of agents) byCopy.set(agent.workdir, [...(byCopy.get(agent.workdir) ?? []), agent]);
  return [...byCopy.entries()].filter(([, users]) => {
    if (users.some((agent) => agent.containerId || !STOPPED.includes(agent.status))) return false;
    const lastActivity = Math.max(...users.map((agent) => agent.lastActivityAt.getTime()));
    const lastMirror = Math.max(...users.map((agent) => agent.mirroredAt?.getTime() ?? 0));
    return lastMirror < lastActivity;
  });
}

export async function mirrorCopy(workdir: string) {
  if (!isVolumeCopy(workdir)) return;
  const target = mirrorPath(workdir);
  await rm(target, { recursive: true, force: true });
  await cp(workdirPath(workdir), target, {
    recursive: true,
    force: true,
    filter: (source) => !SKIPPED.has(path.posix.basename(source)),
  });
}

let running = false;

async function tick(log: FastifyBaseLogger) {
  if (running) return;
  running = true;
  try {
    for (const [workdir, users] of await pendingCopies()) {
      try {
        await mirrorCopy(workdir);
        await prisma.agent.updateMany({ where: { id: { in: users.map((agent) => agent.id) } }, data: { mirroredAt: new Date() } });
      } catch (err) {
        log.warn({ workdir, err }, 'Could not mirror an agent copy to Windows');
      }
    }
  } finally {
    running = false;
  }
}

export function startCopyMirror(log: FastifyBaseLogger) {
  const timer = setInterval(() => void tick(log).catch((err: unknown) => log.error({ err }, 'Copy mirror failed')), TICK_MS);
  return () => clearInterval(timer);
}
