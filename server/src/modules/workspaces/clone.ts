import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { GitError, git } from '../../lib/git.js';
import { toContainerPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { authenticatedPushUrl, parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { workspaceNameProblem } from './names.js';
import { stripCredentials } from './scanner.js';
import { scanWorkspaces } from './service.js';

export interface CloneJob {
  id: string;
  workspaceId: string;
  url: string;
  folder: string;
  branch: string | null;
  status: 'cloning' | 'done' | 'failed';
  error: string | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Clones in progress and recent ones, per server process (a restart only loses the progress list). */
const jobs = new Map<string, CloneJob>();
const CLONE_TIMEOUT_MS = 30 * 60_000;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Last segment of the repository path, which is also git's default folder name. */
export function defaultFolder(url: string) {
  const remote = parseRemote(url);
  return remote ? (remote.path.split('/').at(-1) ?? '') : '';
}

export interface CloneInput {
  url: string;
  folder?: string;
  branch?: string;
}

/**
 * Clones a repository into the workspace folder. Private repositories use the workspace git account for
 * the host, only during the clone: "origin" keeps the URL without credentials.
 */
export async function startClone(workspaceId: string, input: CloneInput, log?: FastifyBaseLogger) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  if (workspace.missingAt) throw new HttpError(409, 'A pasta deste workspace não existe mais.');

  const url = stripCredentials(input.url.trim());
  const remote = parseRemote(url);
  if (!remote) throw new HttpError(422, 'URL de repositório não reconhecida. Use a URL de clone (https ou ssh) do GitHub ou GitLab.');

  const folder = input.folder?.trim() || defaultFolder(url);
  const problem = workspaceNameProblem(folder, []);
  if (problem) throw new HttpError(422, problem.replace('workspace', 'pasta do projeto'));

  const dest = toContainerPath(workspace.name, folder);
  const busy = [...jobs.values()].some((job) => job.status === 'cloning' && job.workspaceId === workspaceId && job.folder.toLowerCase() === folder.toLowerCase());
  if (busy || (await exists(dest))) throw new HttpError(409, `Já existe a pasta "${folder}" neste workspace.`);

  const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]).catch(() => null);
  const token = account ? secrets.decrypt(account.tokenEncrypted) : null;
  // The container has no SSH keys, so ssh URLs are cloned over https (with the account token when there is one).
  const cloneUrl = token
    ? authenticatedPushUrl(remote, account!.provider as 'GITHUB' | 'GITLAB', token)
    : /^https?:\/\//i.test(url)
      ? url
      : `https://${remote.host}/${remote.path}.git`;

  const job: CloneJob = {
    id: randomUUID(),
    workspaceId,
    url,
    folder,
    branch: input.branch?.trim() || null,
    status: 'cloning',
    error: null,
    projectId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  void runClone(job, workspace.name, cloneUrl, token, log);
  return job;
}

async function runClone(job: CloneJob, workspaceName: string, cloneUrl: string, token: string | null, log?: FastifyBaseLogger) {
  const dest = toContainerPath(workspaceName, job.folder);
  const redact = (text: string) => (token ? text.replaceAll(token, '***').replaceAll(encodeURIComponent(token), '***') : text);
  try {
    await git(toContainerPath(workspaceName), ['clone', ...(job.branch ? ['--branch', job.branch] : []), cloneUrl, job.folder], {
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    await git(dest, ['remote', 'set-url', 'origin', job.url]);
    await scanWorkspaces();
    const project = await prisma.project.findFirst({ where: { workspaceId: job.workspaceId, name: job.folder } });
    Object.assign(job, { status: 'done', projectId: project?.id ?? null, finishedAt: new Date().toISOString() });
  } catch (error) {
    const raw = error instanceof GitError ? error.stderr || error.message : error instanceof Error ? error.message : String(error);
    const message = redact(raw).trim().split('\n').slice(-3).join(' ');
    // The branch check comes first: its message also says "not found".
    const hint = /remote branch .* not found/i.test(message)
      ? ' A branch informada não existe no repositório.'
      : /authentication|could not read username|403|not found/i.test(message)
        ? ' Confira se o workspace tem uma conta git com acesso a este repositório.'
        : '';
    Object.assign(job, { status: 'failed', error: `${message}${hint}`.slice(0, 600), finishedAt: new Date().toISOString() });
    // A failed clone leaves a partial folder behind; it was created by this clone, so it goes away.
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    log?.warn({ workspaceId: job.workspaceId, folder: job.folder }, 'Clone failed');
  }
}

export function listCloneJobs(workspaceId: string) {
  return [...jobs.values()]
    .filter((job) => job.workspaceId === workspaceId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 10);
}
