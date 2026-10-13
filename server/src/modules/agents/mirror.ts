import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { isVolumeCopy, mirrorPath, workdirPath } from './workdir.js';

/**
 * Copies in the Docker volume are invisible from Windows. On request (a button on the agent page) the code, without
 * .git and the build folders, is copied to the Windows folder, or downloaded as an archive. Nothing is copied
 * automatically: the slow disk stays free for the agents.
 */

/** Big and regenerable: the history is in the branch/PR, the rest comes back with an install or a build. */
const SKIPPED = ['.git', 'node_modules', 'target', '.gradle', '.venv'];
const mirroring = new Set<string>();

export const isMirroring = (workdir: string) => mirroring.has(workdir);

async function mirrorCopy(workdir: string) {
  const target = mirrorPath(workdir);
  await rm(target, { recursive: true, force: true });
  await cp(workdirPath(workdir), target, {
    recursive: true,
    force: true,
    filter: (source) => !SKIPPED.includes(path.posix.basename(source)),
  });
}

/** Starts copying the copy's code to the Windows folder in the background; false when it is already being copied. */
export function requestMirror(agent: { id: string; workdir: string }, log: FastifyBaseLogger) {
  if (!isVolumeCopy(agent.workdir) || mirroring.has(agent.workdir)) return false;
  mirroring.add(agent.workdir);
  void mirrorCopy(agent.workdir)
    .then(() => prisma.agent.updateMany({ where: { workdir: agent.workdir }, data: { mirroredAt: new Date() } }))
    .catch((err: unknown) => log.warn({ agentId: agent.id, err }, 'Could not copy an agent copy to Windows'))
    .finally(() => mirroring.delete(agent.workdir));
  return true;
}

/** The copy's code as a .tar.gz stream (same exclusions as the Windows copy). */
export function copyArchive(workdir: string) {
  const child = spawn('tar', ['-czf', '-', ...SKIPPED.map((name) => `--exclude=${name}`), '-C', workdirPath(workdir), '.']);
  child.stderr.resume();
  return child.stdout;
}
