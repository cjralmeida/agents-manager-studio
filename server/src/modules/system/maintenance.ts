import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ensureImage, pruneBuildCache, pruneDanglingImages, runOnce } from '../../lib/docker.js';
import { getResourceUsage } from './service.js';

/**
 * Disk maintenance of the Docker disk, by itself: the build cache and images left behind by rebuilds are deleted,
 * then the free blocks are trimmed, so the space goes back inside Docker's disk file (it stops growing). Shrinking the
 * file itself (compacting the vhdx) needs Docker stopped and an administrator: only when the user asks.
 * Never touches volumes (paused agents keep their data there) or tagged images.
 */

const KEY = 'diskMaintenance';
const TICK_MS = 30 * 60_000;
/** Runs once a day, or sooner (at most every 3 hours) when the agents' disk is short. */
const EVERY_MS = 24 * 60 * 60_000;
const SHORT_EVERY_MS = 3 * 60 * 60_000;
const SHORT_FREE_GB = 25;
const TRIM_IMAGE = 'alpine:3.20';

export interface MaintenanceRun {
  at: string;
  buildCacheGb: number;
  imagesGb: number;
  trimmed: string | null;
  freeDiskGb: number | null;
  error: string | null;
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

export async function lastMaintenance() {
  const row = await prisma.studioSetting.findUnique({ where: { key: KEY } });
  return (row?.value as unknown as MaintenanceRun | undefined) ?? null;
}

async function agentsDiskFreeGb() {
  const usage = await getResourceUsage().catch(() => null);
  const disk = usage?.host?.disks.find((entry) => entry.agents);
  return disk ? gb(disk.free) : null;
}

/** One maintenance round; skipped while a test environment is being built (its build uses the cache). */
export async function runDiskMaintenance(log?: FastifyBaseLogger): Promise<MaintenanceRun | null> {
  const building = await prisma.testEnvironment.count({ where: { status: 'building' } });
  if (building > 0) return null;
  const run: MaintenanceRun = { at: new Date().toISOString(), buildCacheGb: 0, imagesGb: 0, trimmed: null, freeDiskGb: null, error: null };
  try {
    run.buildCacheGb = gb(await pruneBuildCache());
    run.imagesGb = gb(await pruneDanglingImages());
    await ensureImage(TRIM_IMAGE);
    const trim = await runOnce({
      image: TRIM_IMAGE,
      cmd: ['nsenter', '-t', '1', '-m', '--', 'fstrim', '-av'],
      privileged: true,
      pidMode: 'host',
      timeoutMs: 10 * 60_000,
    });
    run.trimmed = (trim.stdout || trim.stderr).trim().split('\n').filter(Boolean).join(' · ').slice(0, 500) || null;
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  run.freeDiskGb = await agentsDiskFreeGb();
  await prisma.studioSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: run as unknown as Prisma.InputJsonValue },
    update: { value: run as unknown as Prisma.InputJsonValue },
  });
  log?.info(run, 'Disk maintenance');
  return run;
}

async function due() {
  const last = await lastMaintenance();
  if (!last) return true;
  const since = Date.now() - new Date(last.at).getTime();
  if (since >= EVERY_MS) return true;
  const free = await agentsDiskFreeGb();
  return free !== null && free < SHORT_FREE_GB && since >= SHORT_EVERY_MS;
}

export function startDiskMaintenance(log: FastifyBaseLogger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (await due()) await runDiskMaintenance(log);
    } catch (err) {
      log.warn({ err }, 'Disk maintenance failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
