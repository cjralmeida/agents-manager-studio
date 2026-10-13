import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { PreviewBuild, Project } from '../../generated/prisma/client.js';
import { inspectContainer, removeImage } from '../../lib/docker.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { GitError, git } from '../../lib/git.js';
import { secrets } from '../../lib/secrets.js';
import { authenticatedPushUrl, parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { type PreviewKind, UNSUPPORTED, type Workspace, detect, runCheck as runKindCheck, serve, unserve } from './runners.js';
import { deleteProjectVariable, listProjectVariables, projectEnv, setProjectVariable } from './variables.js';

/**
 * "Rodar" a project: the Studio checks each new commit of the base branch in throwaway containers and serves the latest
 * one that passed at http://<project>.localhost, swapping it when a newer one passes. Projects run as a docker compose
 * stack, a Dockerfile image or a static Node build (runners.ts). Everything happens in its own folder and containers,
 * apart from the agents' copies.
 */

const PREVIEWS_DIR = 'previews';
const LOG_TAIL = 4_000;

const checking = new Set<string>();
/** One check at a time across the Studio, so checks never compete with the agents for the machine. */
let queue: Promise<unknown> = Promise.resolve();

export function previewSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'projeto';
}

const previewUrl = (project: Pick<Project, 'name'>) => `http://${previewSlug(project.name)}.localhost`;
// Preview builds live in the agents' Docker volume (fast); the daemon path is what docker compose binds resolve to.
const buildDir = (projectId: string, commit: string) => path.posix.join(config.agentsVolumeDir, PREVIEWS_DIR, projectId, commit.slice(0, 12));
const buildHostDir = (projectId: string, commit: string) => path.posix.join(config.agentsVolumeDaemonDir, PREVIEWS_DIR, projectId, commit.slice(0, 12));
const tail = (text: string) => (text.length > LOG_TAIL ? `…${text.slice(-LOG_TAIL)}` : text);

async function findProject(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Projeto não encontrado.');
  return project;
}

/** Fetch URL with the workspace account's token, and the branch to follow (the base branch, or the remote's default). */
async function remoteOf(project: Project) {
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto não tem repositório remoto: o Rodar usa a versão do GitHub/GitLab.');
  const account = await findWorkspaceGitAccount(project.workspaceId, [remoteHostname(remote), remote.host]);
  const url = authenticatedPushUrl(remote, account.provider as 'GITHUB' | 'GITLAB', secrets.decrypt(account.tokenEncrypted));
  let branch = project.baseBranch;
  if (!branch) {
    const head = await git('/tmp', ['ls-remote', '--symref', url, 'HEAD'], { timeoutMs: 30_000 });
    branch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head)?.[1] ?? 'main';
  }
  return { url, cleanUrl: project.gitRemoteUrl!, branch };
}

async function headCommit(url: string, branch: string) {
  const out = await git('/tmp', ['ls-remote', url, `refs/heads/${branch}`], { timeoutMs: 30_000 });
  const commit = out.split(/\s+/)[0];
  if (!commit) throw new HttpError(422, `A branch "${branch}" não existe no repositório remoto.`);
  return commit;
}

async function finish(build: PreviewBuild, status: 'PASSED' | 'FAILED', log: string, target?: string) {
  return prisma.previewBuild.update({ where: { id: build.id }, data: { status, log: tail(log), target: target ?? null, finishedAt: new Date() } });
}

const workspaceOf = (project: Project, commit: string, env: Record<string, string> = {}): Workspace => ({
  projectId: project.id,
  slug: previewSlug(project.name),
  src: `${buildDir(project.id, commit)}/src`,
  srcHost: `${buildHostDir(project.id, commit)}/src`,
  commit,
  env,
});

/** Clones the newest commit and checks it the way its kind runs (see runners.ts); returns the finished build. */
async function runCheck(project: Project, remote: Awaited<ReturnType<typeof remoteOf>>, commit: string) {
  const staging = buildDir(project.id, `clone-${commit}`);
  await rm(staging, { recursive: true, force: true });
  await git('/tmp', ['clone', '--quiet', '--depth', '1', '--branch', remote.branch, remote.url, staging], { timeoutMs: 300_000 });
  await git(staging, ['remote', 'set-url', 'origin', remote.cleanUrl]);
  // A newer commit may have arrived between the look and the clone: the folder is named after what was cloned.
  const actual = (await git(staging, ['rev-parse', 'HEAD'])).trim();
  const message = (await git(staging, ['log', '-1', '--format=%s'])).trim();
  const ws = workspaceOf(project, actual, await projectEnv(project.id));
  await rm(buildDir(project.id, actual), { recursive: true, force: true });
  await mkdir(buildDir(project.id, actual), { recursive: true });
  await rename(staging, ws.src);

  const detected = await detect(ws.src);
  const build = await prisma.previewBuild.create({
    data: { projectId: project.id, branch: remote.branch, commit: actual, commitMessage: message.slice(0, 300), kind: detected?.kind ?? 'static' },
  });
  if (!detected) return finish(build, 'FAILED', UNSUPPORTED);
  const result = await runKindCheck(ws, detected);
  return finish(build, result.passed ? 'PASSED' : 'FAILED', result.log, result.target);
}

/**
 * Checks the newest commit of the base branch when it was not checked yet (or always, with `force`). Runs in the
 * background; the state shows it as running.
 */
export async function checkLatest(projectId: string, options: { force?: boolean; log?: FastifyBaseLogger } = {}) {
  const project = await findProject(projectId);
  if (checking.has(projectId)) return;
  const remote = await remoteOf(project);
  const commit = await headCommit(remote.url, remote.branch);
  const known = await prisma.previewBuild.findFirst({ where: { projectId, commit }, orderBy: { startedAt: 'desc' } });
  if (known && !options.force) return;

  checking.add(projectId);
  const job = queue.then(async () => {
    try {
      const build = await runCheck(project, remote, commit);
      options.log?.info({ projectId, commit: build.commit, status: build.status }, 'Preview check finished');
      if (build.status === 'PASSED') await serveIfWanted(projectId);
      await cleanup(projectId);
    } catch (error) {
      const message = error instanceof GitError ? error.message : error instanceof Error ? error.message : String(error);
      options.log?.warn({ projectId, err: error }, 'Preview check failed to run');
      const log = tail(message.replaceAll(remote.url, remote.cleanUrl));
      const started = await prisma.previewBuild.findFirst({ where: { projectId, status: 'RUNNING' } });
      if (started) await prisma.previewBuild.update({ where: { id: started.id }, data: { status: 'FAILED', log, finishedAt: new Date() } });
      else await prisma.previewBuild.create({ data: { projectId, branch: remote.branch, commit, status: 'FAILED', log, finishedAt: new Date() } });
    } finally {
      checking.delete(projectId);
    }
  });
  queue = job.catch(() => undefined);
}

const stableBuild = (projectId: string) =>
  prisma.previewBuild.findFirst({ where: { projectId, status: 'PASSED' }, orderBy: { startedAt: 'desc' } });

const serving = new Set<string>();

/** Starts (or swaps) what serves the stable build, when the user wants the project up. */
async function serveIfWanted(projectId: string) {
  if (serving.has(projectId)) return;
  const preview = await prisma.projectPreview.findUnique({ where: { projectId }, include: { project: true } });
  if (!preview?.wantsUp) return;
  const stable = await stableBuild(projectId);
  if (!stable) return;
  const state = preview.containerId ? await inspectContainer(preview.containerId).catch(() => null) : null;
  if (state?.running && preview.buildId === stable.id) return;

  serving.add(projectId);
  try {
    // Static builds from before the target column name their folder in the log.
    const target = stable.target ?? /^Site em (\w+)\//.exec(stable.log)?.[1] ?? null;
    const ws = workspaceOf(preview.project, stable.commit, await projectEnv(projectId));
    const containerId = await serve(ws, stable.kind as PreviewKind, target);
    await prisma.projectPreview.update({ where: { projectId }, data: { containerId, buildId: stable.id, error: null } });
  } catch (error) {
    await prisma.projectPreview.update({
      where: { projectId },
      data: { containerId: null, error: tail(error instanceof Error ? error.message : String(error)) },
    });
  } finally {
    serving.delete(projectId);
  }
}

/** Keeps the folders of the served build and of the two latest checks; the rest is deleted. */
async function cleanup(projectId: string) {
  const preview = await prisma.projectPreview.findUnique({ where: { projectId } });
  const keep = new Set(
    (await prisma.previewBuild.findMany({ where: { projectId }, orderBy: { startedAt: 'desc' }, take: 2, select: { commit: true } })).map((b) => b.commit.slice(0, 12)),
  );
  if (preview?.buildId) {
    const served = await prisma.previewBuild.findUnique({ where: { id: preview.buildId }, select: { commit: true } });
    if (served) keep.add(served.commit.slice(0, 12));
  }
  const slug = previewSlug((await findProject(projectId)).name);
  const root = path.posix.join(config.agentsVolumeDir, PREVIEWS_DIR, projectId);
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (keep.has(entry)) continue;
    await rm(path.posix.join(root, entry), { recursive: true, force: true });
    // The image built from that commit (Dockerfile projects) goes with it.
    await removeImage(`ams-preview-${slug}:${entry}`);
  }
}

export async function startPreview(projectId: string, log?: FastifyBaseLogger) {
  const project = await findProject(projectId);
  await remoteOf(project);
  await prisma.projectPreview.upsert({ where: { projectId }, create: { projectId, wantsUp: true }, update: { wantsUp: true, error: null } });
  await serveIfWanted(projectId);
  await checkLatest(projectId, { log });
  return previewState(projectId);
}

export async function stopPreview(projectId: string) {
  const project = await findProject(projectId);
  const preview = await prisma.projectPreview.findUnique({ where: { projectId } });
  const served = preview?.buildId ? await prisma.previewBuild.findUnique({ where: { id: preview.buildId } }) : null;
  if (served) await unserve(workspaceOf(project, served.commit), served.kind as PreviewKind);
  await prisma.projectPreview.upsert({ where: { projectId }, create: { projectId }, update: { wantsUp: false, containerId: null } });
  return previewState(projectId);
}

const buildView = (build: PreviewBuild | null, withLog = false) =>
  build && {
    id: build.id,
    status: build.status,
    branch: build.branch,
    commit: build.commit,
    commitMessage: build.commitMessage,
    kind: build.kind,
    target: build.target,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    ...(withLog && { log: build.log }),
  };

export async function previewState(projectId: string) {
  const project = await findProject(projectId);
  const [preview, latest, stable] = await Promise.all([
    prisma.projectPreview.findUnique({ where: { projectId } }),
    prisma.previewBuild.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } }),
    stableBuild(projectId),
  ]);
  const served = preview?.buildId ? await prisma.previewBuild.findUnique({ where: { id: preview.buildId } }) : null;
  const container = preview?.containerId ? await inspectContainer(preview.containerId).catch(() => null) : null;
  return {
    supported: Boolean(project.gitRemoteUrl),
    url: previewUrl(project),
    wantsUp: preview?.wantsUp ?? false,
    running: Boolean(container?.running),
    checking: checking.has(projectId),
    error: preview?.error ?? null,
    served: buildView(served),
    stable: buildView(stable),
    latest: buildView(latest, latest?.status === 'FAILED'),
  };
}

/** Periodic work: looks for new commits of the projects that are up and keeps their containers running. */
export async function previewTick(log: FastifyBaseLogger) {
  const previews = await prisma.projectPreview.findMany({ where: { wantsUp: true }, select: { projectId: true } });
  for (const { projectId } of previews) {
    try {
      await serveIfWanted(projectId);
      await checkLatest(projectId, { log });
    } catch (err) {
      log.warn({ projectId, err }, 'Preview tick failed');
    }
  }
}

/** After a restart, a check that was running is lost: it is marked as failed. */
export async function recoverPreviews() {
  await prisma.previewBuild.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', log: 'A verificação foi interrompida (o Studio reiniciou). Clique em "Verificar agora".', finishedAt: new Date() },
  });
}

/** Starts the periodic work (every 2 minutes) and marks checks interrupted by a restart; returns a stop function. */
export function startPreviewMonitor(log: FastifyBaseLogger) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    try {
      await previewTick(log);
    } catch (err) {
      log.error({ err }, 'Preview monitor failed');
    }
    if (!stopped) timer = setTimeout(run, 120_000);
  };
  void recoverPreviews().then(run, (err: unknown) => log.error({ err }, 'Preview recovery failed'));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export { listProjectVariables };

/** Saves a variable; a project that is up is checked again with it (and swapped when the check passes). */
export async function saveProjectVariable(projectId: string, key: string, value: string, log?: FastifyBaseLogger) {
  await setProjectVariable(projectId, key, value);
  await recheckIfUp(projectId, log);
  return listProjectVariables(projectId);
}

export async function removeProjectVariable(projectId: string, key: string, log?: FastifyBaseLogger) {
  await deleteProjectVariable(projectId, key);
  await recheckIfUp(projectId, log);
  return listProjectVariables(projectId);
}

async function recheckIfUp(projectId: string, log?: FastifyBaseLogger) {
  const preview = await prisma.projectPreview.findUnique({ where: { projectId } });
  if (preview?.wantsUp) await checkLatest(projectId, { force: true, log }).catch((err: unknown) => log?.warn({ projectId, err }, 'Re-check failed to start'));
}
