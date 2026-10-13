import { rm } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { freeAgentsDiskGb } from '../system/service.js';
import { copyExpired, FINISHED } from './cleanup-policy.js';
import { removeBuildVolumes } from './build-dirs.js';
import { workdirPath } from './workdir.js';

/**
 * Copies of finished agents are deleted after a while: each copy holds the whole project (with node_modules), and
 * keeping every one filled the disk. A completed agent's work is already in its PR/MR; failed and cancelled ones are
 * kept longer in case the user wants to look at them. Copies a running workflow still needs (the next step continues
 * from it, or a send-back reopens it) are kept until the run ends.
 */

const TICK_MS = 60 * 60_000;

export async function cleanFinishedCopies(log: FastifyBaseLogger) {
  const free = await freeAgentsDiskGb();
  const diskShort = free !== null && free < config.minFreeDiskGb;
  const agents = await prisma.agent.findMany({
    where: { workdirRemovedAt: null },
    select: { id: true, workdir: true, status: true, containerId: true, finishedAt: true, lastActivityAt: true, workflowRun: { select: { status: true } } },
  });
  const now = new Date();
  const retention = { completedHours: config.copyRetentionHours, failedDays: config.failedCopyRetentionDays, diskShort };
  // Steps of a workflow run may share one copy: it goes only when every agent using it may let it go.
  const byCopy = new Map<string, typeof agents>();
  for (const agent of agents) byCopy.set(agent.workdir, [...(byCopy.get(agent.workdir) ?? []), agent]);
  let removed = 0;
  for (const [workdir, users] of byCopy) {
    const expired = users.every(
      (agent) => !agent.containerId && (FINISHED as readonly string[]).includes(agent.status) && copyExpired({ ...agent, runStatus: agent.workflowRun?.status ?? null }, now, retention),
    );
    if (!expired) continue;
    try {
      await rm(workdirPath(workdir), { recursive: true, force: true, maxRetries: 2 });
      for (const agent of users) await removeBuildVolumes(agent);
      await prisma.agent.updateMany({ where: { id: { in: users.map((agent) => agent.id) } }, data: { workdirRemovedAt: new Date() } });
      removed++;
    } catch (err) {
      log.warn({ workdir, err }, 'Could not delete the copy of finished agents');
    }
  }
  if (removed > 0) log.info({ removed, diskShort, freeGb: free }, 'Deleted copies of finished agents');
  return removed;
}

export function startCopyCleanup(log: FastifyBaseLogger) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    cleanFinishedCopies(log)
      .catch((err: unknown) => log.error({ err }, 'Copy cleanup failed'))
      .finally(() => (running = false));
  };
  // Also checks the disk every 5 minutes: when it is short, the cleanup runs right away instead of waiting the hour.
  const hourly = setInterval(tick, TICK_MS);
  const diskWatch = setInterval(() => {
    void freeAgentsDiskGb().then((free) => {
      if (free !== null && free < config.minFreeDiskGb) tick();
    });
  }, 5 * 60_000);
  setTimeout(tick, 60_000).unref();
  return () => {
    clearInterval(hourly);
    clearInterval(diskWatch);
  };
}
