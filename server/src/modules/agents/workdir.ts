import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import type { ContainerMount } from '../../lib/docker.js';
import { git, GitError } from '../../lib/git.js';
import { HttpError } from '../../lib/errors.js';

/** UID/GID of the "node" user that runs inside agent containers. */
const AGENT_UID = '1000:1000';
/** Enough history for the agent to inspect recent changes, without copying the whole repository. */
const CLONE_DEPTH = '200';
const MAX_PATCH_BYTES = 1_000_000;

/**
 * New copies live in a Docker volume (config.agentsVolume): git, builds and tests run there without the slow Windows
 * bridge (a `git status` on a big repository took 5 minutes through it). Their `workdir` starts with this prefix;
 * copies made before stay in the Windows folder. The code of a volume copy is mirrored to the Windows folder when its
 * agents finish (see mirror.ts), so the user still finds it there.
 */
export const VOLUME_PREFIX = 'vol:';
export const isVolumeCopy = (workdir: string) => workdir.startsWith(VOLUME_PREFIX);
const relativeWorkdir = (workdir: string) => (isVolumeCopy(workdir) ? workdir.slice(VOLUME_PREFIX.length) : workdir);

export function workdirPath(workdir: string) {
  return isVolumeCopy(workdir)
    ? path.posix.join(config.agentsVolumeDir, relativeWorkdir(workdir))
    : path.posix.join(config.agentsDir, workdir);
}

/** Where the user finds the copy on Windows (for a volume copy: its code mirror, written when the agents finish). */
export function workdirHostPath(workdir: string) {
  return `${config.agentsHostDir}/${relativeWorkdir(workdir)}`;
}

/** The Windows mirror of a volume copy, as seen by the server. */
export function mirrorPath(workdir: string) {
  return path.posix.join(config.agentsDir, relativeWorkdir(workdir));
}

/** Mount of the copy, or of a folder inside it, into a container. */
export function workdirMount(workdir: string, target: string, folder = '', readOnly = false): ContainerMount {
  if (isVolumeCopy(workdir)) {
    return { Type: 'volume', Source: config.agentsVolume, Target: target, ReadOnly: readOnly, VolumeOptions: { Subpath: path.posix.join(relativeWorkdir(workdir), folder) } };
  }
  return { Type: 'bind', Source: folder ? `${workdirHostPath(workdir)}/${folder}` : workdirHostPath(workdir), Target: target, ReadOnly: readOnly };
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
  /** Branch to clone when it is not the base (continuing another agent: its branch). */
  cloneBranch?: string;
}) {
  const cloneBranch = input.cloneBranch ?? input.baseBranch;
  const dest = workdirPath(input.workdir);
  await mkdir(path.posix.dirname(dest), { recursive: true });

  try {
    await git(path.posix.dirname(dest), [
      'clone',
      '--depth',
      CLONE_DEPTH,
      '--single-branch',
      '--branch',
      cloneBranch,
      '--no-tags',
      `file://${input.projectDir}`,
      dest,
    ], { timeoutMs: 1_800_000 }); // big repositories on a slow bind mount (Docker on Windows) take a while
  } catch (error) {
    if (error instanceof GitError && /not found in upstream|Remote branch .* not found/i.test(error.stderr)) {
      throw new HttpError(422, `A branch "${cloneBranch}" não existe no projeto.`);
    }
    throw error;
  }

  if (input.remoteUrl) await git(dest, ['remote', 'set-url', 'origin', input.remoteUrl]);
  else await git(dest, ['remote', 'remove', 'origin']);
  // Continuing another agent keeps its branch; a new copy gets its own.
  if (input.branch !== cloneBranch) await git(dest, ['checkout', '-q', '-b', input.branch]);
  const baseCommit = (await git(dest, ['rev-parse', 'HEAD'])).trim();

  // The clone is created by this (root) process; the agent container runs as "node".
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dest], () => resolve()));
  return { baseCommit };
}

/**
 * Moves a fresh copy to the latest base branch on the remote, so agents build on work already merged
 * there (e.g. by earlier workflow steps). The local project is kept when it has commits the remote lacks.
 * Returns the new base commit, or null when the copy stays as it was.
 */
export async function updateToRemoteBase(input: { workdir: string; baseBranch: string; fetchUrl: string; token: string }) {
  const dir = workdirPath(input.workdir);
  const redact = (text: string) => text.replaceAll(input.token, '***').replaceAll(encodeURIComponent(input.token), '***');
  try {
    await git(dir, ['fetch', '--quiet', '--depth', CLONE_DEPTH, input.fetchUrl, input.baseBranch], { timeoutMs: 300_000 });
    const local = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const remote = (await git(dir, ['rev-parse', 'FETCH_HEAD'])).trim();
    if (local === remote) return null;
    const behind = await git(dir, ['merge-base', '--is-ancestor', local, remote]).then(
      () => true,
      () => false,
    );
    if (!behind) return null;
    await git(dir, ['reset', '--quiet', '--hard', remote]);
    await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dir], () => resolve()));
    return remote;
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  }
}

/**
 * Merges the latest base branch from the remote into the agent's branch, e.g. when its approved PR/MR conflicts with
 * work merged meanwhile. A clean merge is committed; with conflicts the merge stays in progress (markers in the
 * files) for the agent to resolve, and the Studio's commit at the end concludes it. Returns the conflicting files.
 */
export async function mergeRemoteBase(input: {
  workdir: string;
  baseBranch: string;
  fetchUrl: string;
  token: string;
  author: { name: string; email: string };
}) {
  const dir = workdirPath(input.workdir);
  const redact = (text: string) => text.replaceAll(input.token, '***').replaceAll(encodeURIComponent(input.token), '***');
  const identity = ['-c', `user.name=${input.author.name}`, '-c', `user.email=${input.author.email}`];
  const merge = () => git(dir, [...identity, 'merge', '--no-edit', '-m', `Merge ${input.baseBranch} (resolver conflitos)`, 'FETCH_HEAD']);
  try {
    // Pending edits would mix with the merge; they are committed first (the Studio commits everything anyway).
    await git(dir, ['add', '--all']);
    if ((await git(dir, ['status', '--porcelain'])).trim()) await git(dir, [...identity, 'commit', '-q', '-m', 'Alterações antes do merge da base']);
    await git(dir, ['fetch', '--quiet', '--depth', CLONE_DEPTH, input.fetchUrl, input.baseBranch], { timeoutMs: 300_000 });
    try {
      await merge();
      return [];
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      // The copies are shallow: without the common ancestor, git refuses; bring the whole history and try again.
      if (/unrelated histories/i.test(error.message)) {
        await git(dir, ['fetch', '--quiet', '--unshallow', input.fetchUrl, input.baseBranch], { timeoutMs: 600_000 });
        try {
          await merge();
          return [];
        } catch (retryError) {
          if (!(retryError instanceof GitError)) throw retryError;
        }
      }
      const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      if (conflicts.length === 0) {
        await git(dir, ['merge', '--abort']).catch(() => undefined);
        throw error;
      }
      return conflicts;
    }
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  } finally {
    await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dir], () => resolve()));
  }
}

/** Files of a merge in progress that still have conflict markers (the agent has not resolved them yet). */
export async function unresolvedConflicts(workdir: string) {
  const dir = workdirPath(workdir);
  const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
  const marked: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), 'utf8').catch(() => '');
    if (/^(<{7}|>{7})( |$)|^={7}$/m.test(text)) marked.push(file);
  }
  return marked;
}

/** Moves the copy to a branch fetched from the remote (e.g. a person's PR/MR branch); returns its head commit. */
export async function checkoutRemoteBranch(input: { workdir: string; branch: string; fetchUrl: string; token: string }) {
  const dir = workdirPath(input.workdir);
  const redact = (text: string) => text.replaceAll(input.token, '***').replaceAll(encodeURIComponent(input.token), '***');
  try {
    await git(dir, ['fetch', '--quiet', '--depth', CLONE_DEPTH, input.fetchUrl, input.branch], { timeoutMs: 300_000 });
    await git(dir, ['checkout', '--quiet', '-B', input.branch, 'FETCH_HEAD']);
    await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dir], () => resolve()));
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  }
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
  /** Pushes even when the copy has nothing new since the base (e.g. publishing a branch other agents built). */
  allowUnchanged?: boolean;
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
    if (head === input.baseCommit && !input.allowUnchanged) throw new HttpError(422, NO_CHANGES_MESSAGE);

    await git(dir, ['push', '--quiet', input.pushUrl, `HEAD:refs/heads/${input.branch}`], { timeoutMs: 300_000 });
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  }
}

/** Gives the copy back to the agent container's user after the server ran git in it (e.g. a mid-run commit). */
export async function returnToAgent(workdir: string) {
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, workdirPath(workdir)], () => resolve()));
}

/** Whether everything in the copy is already in the base branch on the remote (nothing left to merge). */
export async function isMergedInto(input: { workdir: string; baseBranch: string; fetchUrl: string; token: string }) {
  const dir = workdirPath(input.workdir);
  const redact = (text: string) => text.replaceAll(input.token, '***').replaceAll(encodeURIComponent(input.token), '***');
  try {
    await git(dir, ['fetch', '--quiet', '--depth', CLONE_DEPTH, input.fetchUrl, input.baseBranch], { timeoutMs: 300_000 });
    return await git(dir, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']).then(
      () => true,
      () => false,
    );
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(502, redact(error.message));
    throw error;
  }
}

/**
 * Brings into an agent's copy the commits another agent made on the same branch (fast-forward only), e.g. the
 * tests a review step wrote before sending the work back.
 */
export async function fastForwardFrom(input: { workdir: string; fromWorkdir: string; branch: string }) {
  const dir = workdirPath(input.workdir);
  await git(dir, ['fetch', '--quiet', `file://${workdirPath(input.fromWorkdir)}`, input.branch]);
  await git(dir, ['merge', '--quiet', '--ff-only', 'FETCH_HEAD']);
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dir], () => resolve()));
}

export async function removeWorkdir(workdir: string) {
  await rm(workdirPath(workdir), { recursive: true, force: true });
  if (isVolumeCopy(workdir)) await rm(mirrorPath(workdir), { recursive: true, force: true });
}
