import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import path from 'node:path';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { removeVolume, runOnce, volumeExists } from '../../lib/docker.js';
import { VOLUME_PREFIX, workdirPath } from './workdir.js';

/**
 * The heavy folders a build writes (node_modules, target, .gradle, .venv) live in Docker volumes instead of the copy:
 * the copy is a Windows folder mounted into the container, and every file through that bridge is slow, worse on a
 * hard disk. A volume stays in Docker's own disk (ext4), so installs, builds and tests run several times faster.
 * The code itself stays in the copy, visible in Windows as before.
 */

const BUILD_DIRS: { dir: string; markers: string[]; lockfiles?: string[] }[] = [
  { dir: 'node_modules', markers: ['package.json'], lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'] },
  { dir: 'target', markers: ['pom.xml'] },
  { dir: '.gradle', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { dir: '.venv', markers: ['pyproject.toml', 'requirements.txt'], lockfiles: ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt'] },
];

// ---------------------------------------------------------------- ready dependencies per project

/**
 * Installed dependencies (node_modules, .venv) are kept per project and lockfile version in the agents volume
 * (`.deps/<workspace>/<project>/<dir>-<hash>`). A new copy of the project with the same lockfile starts with them (a
 * copy inside Docker, seconds) and the agent only installs what changed. The two newest versions per project stay.
 */
const SEEDS_DIR = '.deps';
const SEEDS_KEPT = 2;
const SEED_TICK_MS = 10 * 60_000;

/** "vol:GlobalFarm/globalfarm-1a2b3c4d" -> "GlobalFarm/globalfarm" (copies of the same project share seeds). */
function projectKey(workdir: string) {
  const relative = workdir.startsWith(VOLUME_PREFIX) ? workdir.slice(VOLUME_PREFIX.length) : workdir;
  return relative.replace(/-[0-9a-f]{8}$/, '');
}

/** Hash of the copy's lockfile for that folder, or null when it has none. */
async function lockHash(workdir: string, lockfiles: string[] | undefined) {
  for (const name of lockfiles ?? []) {
    const content = await readFile(path.posix.join(workdirPath(workdir), name)).catch(() => null);
    if (content) return createHash('sha256').update(name).update(content).digest('hex').slice(0, 16);
  }
  return null;
}

const seedRelative = (workdir: string, dir: string, hash: string) => path.posix.join(SEEDS_DIR, projectKey(workdir), `${dir.replace(/^\./, '')}-${hash}`);

/** Same uid as the "node" user of the agent-runner image. */
const AGENT_UID = '1000:1000';

/** Named after the copy (not the agent): steps of a workflow that share a copy also share what was installed. */
export function buildVolumeName(workdir: string, dir: string) {
  return `ams-build-${workdir.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${dir.replace(/^\./, '')}`;
}

function isEmptyOrMissing(dir: string) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** Binds for the build folders this copy uses; a folder the copy already filled stays where it is. */
export async function buildDirBinds(agent: { id: string; workdir: string }) {
  const root = workdirPath(agent.workdir);
  const binds: string[] = [];
  for (const { dir, markers } of BUILD_DIRS) {
    if (!markers.some((marker) => existsSync(path.posix.join(root, marker)))) continue;
    if (!isEmptyOrMissing(path.posix.join(root, dir))) continue;
    const name = buildVolumeName(agent.workdir, dir);
    // A new volume belongs to root; the agent runs as "node". Fixed once, when the volume is created.
    if (!(await volumeExists(name))) {
      // A new volume belongs to root and starts with the project's ready dependencies, when there are some.
      const lockfiles = BUILD_DIRS.find((entry) => entry.dir === dir)?.lockfiles;
      const hash = await lockHash(agent.workdir, lockfiles);
      const seed = hash ? seedRelative(agent.workdir, dir, hash) : null;
      const seeded = seed !== null && existsSync(path.posix.join(config.agentsVolumeDir, seed));
      const result = await runOnce({
        image: config.agentRunnerImage,
        user: 'root',
        cmd: ['sh', '-c', seeded ? `cp -a /seed/. /v/ && chown -R ${AGENT_UID} /v` : `chown ${AGENT_UID} /v`],
        binds: [`${name}:/v`],
        mounts: seeded ? [{ Type: 'volume', Source: config.agentsVolume, Target: '/seed', ReadOnly: true, VolumeOptions: { Subpath: seed! } }] : [],
        timeoutMs: 600_000,
      });
      if (result.exitCode !== 0) continue;
    }
    binds.push(`${name}:/workspace/${dir}`);
  }
  return binds;
}

const captured = new Set<string>();

/** Keeps the dependencies of copies whose agents stopped, when that project/lockfile version is not kept yet. */
async function captureSeeds(log: FastifyBaseLogger) {
  const agents = await prisma.agent.findMany({
    where: {
      workdir: { startsWith: VOLUME_PREFIX },
      workdirRemovedAt: null,
      containerId: null,
      status: { in: ['READY_FOR_REVIEW', 'COMPLETED'] },
      lastActivityAt: { gte: new Date(Date.now() - 2 * 24 * 60 * 60_000) },
    },
    select: { workdir: true },
    distinct: ['workdir'],
  });
  for (const { workdir } of agents) {
    for (const { dir, lockfiles } of BUILD_DIRS) {
      if (!lockfiles) continue;
      const hash = await lockHash(workdir, lockfiles);
      if (!hash) continue;
      const seed = seedRelative(workdir, dir, hash);
      if (captured.has(seed) || existsSync(path.posix.join(config.agentsVolumeDir, seed))) continue;
      const volume = buildVolumeName(workdir, dir);
      if (!(await volumeExists(volume))) continue;
      captured.add(seed);
      const result = await runOnce({
        image: config.agentRunnerImage,
        user: 'root',
        cmd: ['sh', '-c', `[ -n "$(ls -A /v)" ] || exit 3; rm -rf /deps/${seed}.tmp && mkdir -p /deps/${seed}.tmp && cp -a /v/. /deps/${seed}.tmp/ && mv /deps/${seed}.tmp /deps/${seed}`],
        binds: [`${volume}:/v:ro`],
        mounts: [{ Type: 'volume', Source: config.agentsVolume, Target: '/deps' }],
        timeoutMs: 900_000,
      });
      if (result.exitCode === 0) {
        log.info({ seed }, 'Kept ready dependencies of a project');
        await pruneSeeds(path.posix.dirname(seed), dir);
      } else if (result.exitCode !== 3) captured.delete(seed);
    }
  }
}

/** Only the newest versions of a project's dependencies stay. */
async function pruneSeeds(projectSeeds: string, dir: string) {
  const root = path.posix.join(config.agentsVolumeDir, projectSeeds);
  const prefix = `${dir.replace(/^\./, '')}-`;
  const entries = (await readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp'));
  const dated = await Promise.all(entries.map(async (name) => ({ name, time: (await stat(path.posix.join(root, name))).mtimeMs })));
  for (const old of dated.sort((a, b) => b.time - a.time).slice(SEEDS_KEPT)) await rm(path.posix.join(root, old.name), { recursive: true, force: true });
}

export function startSeedCapture(log: FastifyBaseLogger) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    captureSeeds(log)
      .catch((err: unknown) => log.error({ err }, 'Capturing ready dependencies failed'))
      .finally(() => (running = false));
  }, SEED_TICK_MS);
  return () => clearInterval(timer);
}

export async function removeBuildVolumes(agent: { id: string; workdir: string }) {
  await Promise.all(
    BUILD_DIRS.flatMap(({ dir }) => [
      removeVolume(buildVolumeName(agent.workdir, dir)),
      // Volumes made before they were named after the copy.
      removeVolume(`ams-build-${agent.id}-${dir.replace(/^\./, '')}`),
    ]),
  );
}
