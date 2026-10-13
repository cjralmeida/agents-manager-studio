import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { git, GitError } from '../../lib/git.js';

/**
 * Everything an agent reads from a repository comes from the Docker volume, not from the user's Windows folder (each
 * file through that bridge is slow, worse on a hard disk):
 * - a bare mirror per project (`.git-mirrors/<workspace>/<project>.git`), refreshed from GitHub/GitLab before a copy
 *   is cloned from it;
 * - a checkout of the base branch per reference project (`.context/<workspace>/<project>`), refreshed from the remote
 *   and mounted read-only at /context/<project>.
 * The access token is passed on each fetch and never stored in these repositories.
 */

const MIRRORS_DIR = '.git-mirrors';
const CONTEXTS_DIR = '.context';
/** Enough history for agents to look at recent changes (same as the copies). */
const DEPTH = '200';
const CONTEXT_REFRESH_MS = 10 * 60_000;

export interface RemoteAccess {
  fetchUrl: string;
  token: string;
}

const queues = new Map<string, Promise<unknown>>();
const contextRefreshedAt = new Map<string, number>();

/** Runs one job at a time per repository folder (two agents of a project starting together share the fetch). */
function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(job, job);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** Git errors may echo the authenticated URL: never let the token reach a message. */
async function fetchSafely(dir: string, args: string[], remote: RemoteAccess) {
  try {
    await git(dir, args, { timeoutMs: 1_800_000 });
  } catch (error) {
    const text = error instanceof GitError ? error.stderr : String(error);
    throw new Error(text.replaceAll(remote.token, '***').replaceAll(encodeURIComponent(remote.token), '***').slice(0, 500));
  }
}

const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');

/** The project's bare mirror with `branch` at the remote's tip; returns its path (a clone source). */
export function refreshMirror(workspace: string, project: string, branch: string, remote: RemoteAccess) {
  const dir = path.posix.join(config.agentsVolumeDir, MIRRORS_DIR, safeName(workspace), `${safeName(project)}.git`);
  return serialized(dir, async () => {
    try {
      await access(path.posix.join(dir, 'HEAD'));
    } catch {
      await mkdir(dir, { recursive: true });
      await git(dir, ['init', '--bare', '--quiet']);
    }
    await fetchSafely(dir, ['fetch', '--quiet', '--no-tags', '--depth', DEPTH, remote.fetchUrl, `+refs/heads/${branch}:refs/heads/${branch}`], remote);
    return dir;
  });
}

/**
 * The reference project's base branch, checked out in the volume and brought to the remote's tip (at most every 10
 * minutes); returns the folder's path inside the volume, to mount read-only.
 */
export function refreshContext(projectId: string, workspace: string, project: string, branch: string, remote: RemoteAccess) {
  const relative = path.posix.join(CONTEXTS_DIR, safeName(workspace), safeName(project));
  const dir = path.posix.join(config.agentsVolumeDir, relative);
  return serialized(dir, async () => {
    const fresh = Date.now() - (contextRefreshedAt.get(projectId) ?? 0) < CONTEXT_REFRESH_MS;
    const exists = await access(path.posix.join(dir, '.git')).then(
      () => true,
      () => false,
    );
    if (fresh && exists) return relative;
    if (!exists) {
      await mkdir(dir, { recursive: true });
      await git(dir, ['init', '--quiet']);
    }
    await fetchSafely(dir, ['fetch', '--quiet', '--no-tags', '--depth', DEPTH, remote.fetchUrl, branch], remote);
    await git(dir, ['checkout', '--quiet', '--force', '-B', branch, 'FETCH_HEAD'], { timeoutMs: 600_000 });
    await git(dir, ['clean', '-fdq'], { timeoutMs: 600_000 });
    contextRefreshedAt.set(projectId, Date.now());
    return relative;
  });
}
