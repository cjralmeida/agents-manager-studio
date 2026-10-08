import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { git, GitError } from '../../lib/git.js';
import { HttpError } from '../../lib/errors.js';

/** UID/GID of the "node" user that runs inside agent containers. */
const AGENT_UID = '1000:1000';
/** Enough history for the agent to inspect recent changes, without copying the whole repository. */
const CLONE_DEPTH = '200';
const MAX_PATCH_BYTES = 1_000_000;

export function workdirPath(workdir: string) {
  return path.posix.join(config.agentsDir, workdir);
}

export function workdirHostPath(workdir: string) {
  return `${config.agentsHostDir}/${workdir}`;
}

/** Current branch of the user's repository; null when HEAD is detached. */
export async function currentBranch(projectDir: string) {
  try {
    return (await git(projectDir, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Creates the agent's isolated copy: a shallow clone of the local repository on the base branch,
 * pointing "origin" at the real remote, with a new branch for the agent.
 * Uncommitted changes in the user's working tree are not included.
 */
export async function prepareWorkdir(input: {
  projectDir: string;
  workdir: string;
  baseBranch: string;
  branch: string;
  remoteUrl: string | null;
}) {
  const dest = workdirPath(input.workdir);
  await mkdir(path.posix.dirname(dest), { recursive: true });

  try {
    await git(path.posix.dirname(dest), [
      'clone',
      '--depth',
      CLONE_DEPTH,
      '--single-branch',
      '--branch',
      input.baseBranch,
      '--no-tags',
      `file://${input.projectDir}`,
      dest,
    ], { timeoutMs: 600_000 });
  } catch (error) {
    if (error instanceof GitError && /not found in upstream|Remote branch .* not found/i.test(error.stderr)) {
      throw new HttpError(422, `A branch "${input.baseBranch}" não existe no projeto.`);
    }
    throw error;
  }

  if (input.remoteUrl) await git(dest, ['remote', 'set-url', 'origin', input.remoteUrl]);
  else await git(dest, ['remote', 'remove', 'origin']);
  await git(dest, ['checkout', '-q', '-b', input.branch]);
  const baseCommit = (await git(dest, ['rev-parse', 'HEAD'])).trim();

  // The clone is created by this (root) process; the agent container runs as "node".
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dest], () => resolve()));
  return { baseCommit };
}

/** Work folder for an agent without a repository (e.g. one that only plans tasks). */
export async function prepareEmptyWorkdir(workdir: string) {
  const dest = workdirPath(workdir);
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dest], () => resolve()));
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

/** Everything the agent changed since the base commit, including new files not yet committed. */
export async function workdirDiff(workdir: string, baseCommit: string) {
  const dir = workdirPath(workdir);
  // Makes untracked files visible to "git diff" without staging their content.
  await git(dir, ['add', '--all', '--intent-to-add']);

  const [nameStatus, numstat, patch] = await Promise.all([
    git(dir, ['diff', '--name-status', baseCommit]),
    git(dir, ['diff', '--numstat', baseCommit]),
    git(dir, ['diff', baseCommit]),
  ]);

  const counts = new Map(
    numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...rest] = line.split('\t');
        const toNumber = (value?: string) => (value === undefined || value === '-' ? null : Number(value));
        return [rest.join('\t'), { additions: toNumber(added), deletions: toNumber(removed) }] as const;
      }),
  );

  const files: DiffFile[] = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status = '', ...paths] = line.split('\t');
      const filePath = paths.at(-1) ?? '';
      const count = counts.get(filePath) ?? { additions: null, deletions: null };
      return { path: filePath, status: status.charAt(0), ...count };
    });

  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
  return { files, patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch, truncated };
}

export const NO_CHANGES_MESSAGE = 'O agente não fez nenhuma alteração para enviar.';

/** Commits pending changes (if any) and pushes the agent branch. The token never reaches git config or logs. */
export async function commitAndPush(input: {
  workdir: string;
  baseCommit: string;
  branch: string;
  message: { title: string; body: string };
  author: { name: string; email: string };
  pushUrl: string;
  token: string;
}) {
  const dir = workdirPath(input.workdir);
  const redact = (text: string) => text.replaceAll(input.token, '***').replaceAll(encodeURIComponent(input.token), '***');

  try {
    await git(dir, ['add', '--all']);
    const pending = (await git(dir, ['status', '--porcelain'])).trim();
    if (pending) {
      await git(dir, [
        '-c',
        `user.name=${input.author.name}`,
        '-c',
        `user.email=${input.author.email}`,
        'commit',
        '-q',
        '-m',
        input.message.title,
        '-m',
        input.message.body,
      ]);
    }

    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    if (head === input.baseCommit) throw new HttpError(422, NO_CHANGES_MESSAGE);

    await git(dir, ['push', '--quiet', input.pushUrl, `HEAD:refs/heads/${input.branch}`], { timeoutMs: 300_000 });
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  }
}

export async function removeWorkdir(workdir: string) {
  await rm(workdirPath(workdir), { recursive: true, force: true });
}
