import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { removeVolume, runOnce, volumeExists } from '../../lib/docker.js';
import { workdirPath } from './workdir.js';

/**
 * The heavy folders a build writes (node_modules, target, .gradle, .venv) live in Docker volumes instead of the copy:
 * the copy is a Windows folder mounted into the container, and every file through that bridge is slow, worse on a
 * hard disk. A volume stays in Docker's own disk (ext4), so installs, builds and tests run several times faster.
 * The code itself stays in the copy, visible in Windows as before.
 */

const BUILD_DIRS: { dir: string; markers: string[] }[] = [
  { dir: 'node_modules', markers: ['package.json'] },
  { dir: 'target', markers: ['pom.xml'] },
  { dir: '.gradle', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { dir: '.venv', markers: ['pyproject.toml', 'requirements.txt'] },
];

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
      const result = await runOnce({
        image: config.agentRunnerImage,
        user: 'root',
        cmd: ['chown', AGENT_UID, '/v'],
        binds: [`${name}:/v`],
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) continue;
    }
    binds.push(`${name}:/workspace/${dir}`);
  }
  return binds;
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
