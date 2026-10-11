import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { PreviewBuild, Project } from '../../generated/prisma/client.js';
import { createContainer, inspectContainer, removeContainer, runOnce, startContainer } from '../../lib/docker.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { GitError, git } from '../../lib/git.js';
import { secrets } from '../../lib/secrets.js';
import { authenticatedPushUrl, parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';

/**
 * "Rodar" a project: the Studio checks each new commit of the base branch (install, build and tests in a throwaway
 * container) and serves the latest one that passed at http://<project>.localhost, swapping it when a newer one passes.
 * Everything happens in its own folder and containers, apart from the agents' copies.
 */

const PREVIEWS_DIR = 'previews';
const SERVER_IMAGE = 'caddy:2.10-alpine';
const LABEL = 'studio.preview';
const CHECK_TIMEOUT_MS = 15 * 60_000;
/** Folders the build may write the site to, in order. */
const OUTPUT_DIRS = ['dist', 'build', 'out'];
const LOG_TAIL = 4_000;

const checking = new Set<string>();
/** One check at a time across the Studio, so checks never compete with the agents for the machine. */
let queue: Promise<unknown> = Promise.resolve();

export function previewSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'projeto';
}

const previewUrl = (project: Pick<Project, 'name'>) => `http://${previewSlug(project.name)}.localhost`;
const buildDir = (projectId: string, commit: string) => path.posix.join(config.agentsDir, PREVIEWS_DIR, projectId, commit.slice(0, 12));
const buildHostDir = (projectId: string, commit: string) => `${config.agentsHostDir}/${PREVIEWS_DIR}/${projectId}/${commit.slice(0, 12)}`;
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

const exists = (file: string) => stat(file).then(() => true, () => false);

async function finish(build: PreviewBuild, status: 'PASSED' | 'FAILED', log: string) {
  return prisma.previewBuild.update({ where: { id: build.id }, data: { status, log: tail(log), finishedAt: new Date() } });
}

/** Clones the commit, then installs, builds and tests it in a container; returns the finished build. */
async function runCheck(project: Project, remote: Awaited<ReturnType<typeof remoteOf>>, commit: string) {
  const dir = buildDir(project.id, commit);
  const src = `${dir}/src`;
  await rm(dir, { recursive: true, force: true });
  await git('/tmp', ['clone', '--quiet', '--depth', '1', '--branch', remote.branch, remote.url, src], { timeoutMs: 300_000 });
  await git(src, ['remote', 'set-url', 'origin', remote.cleanUrl]);
  const actual = (await git(src, ['rev-parse', 'HEAD'])).trim();
  const message = (await git(src, ['log', '-1', '--format=%s'])).trim();
  const build = await prisma.previewBuild.create({
    data: { projectId: project.id, branch: remote.branch, commit: actual, commitMessage: message.slice(0, 300) },
  });

  const pkg = await readFile(`${src}/package.json`, 'utf8').then((text) => JSON.parse(text) as { scripts?: Record<string, string> }, () => null);
  if (!pkg?.scripts?.build) {
    return finish(build, 'FAILED', 'O Rodar ainda não sabe rodar este projeto: ele precisa de um package.json com o script "build" que gere um site estático (ex.: Vite em dist/).');
  }

  const result = await runOnce({
    image: config.agentRunnerImage,
    name: `ams-check-${previewSlug(project.name)}-${Date.now().toString(36)}`,
    cmd: ['sh', '-c', 'cd /app && npm ci --no-audit --no-fund && npm run build && npm test --if-present'],
    user: '0',
    env: { CI: 'true', npm_config_update_notifier: 'false' },
    labels: { [LABEL]: project.id },
    binds: [`${buildHostDir(project.id, actual)}/src:/app`],
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.timedOut) return finish(build, 'FAILED', `A verificação passou de ${CHECK_TIMEOUT_MS / 60_000} minutos.\n\n${output}`);
  if (result.exitCode !== 0) return finish(build, 'FAILED', output || `Saiu com código ${result.exitCode}.`);
  const outDir = await (async () => {
    for (const name of OUTPUT_DIRS) if (await exists(`${src}/${name}/index.html`)) return name;
    return null;
  })();
  if (!outDir) return finish(build, 'FAILED', `O build passou, mas não gerou ${OUTPUT_DIRS.map((name) => `${name}/index.html`).join(' nem ')}.\n\n${output}`);
  return finish(build, 'PASSED', `Site em ${outDir}/.\n\n${output}`);
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

/** Starts (or swaps) the container serving the stable build, when the user wants the project up. */
async function serveIfWanted(projectId: string) {
  const preview = await prisma.projectPreview.findUnique({ where: { projectId }, include: { project: true } });
  if (!preview?.wantsUp) return;
  const stable = await stableBuild(projectId);
  if (!stable) return;
  const state = preview.containerId ? await inspectContainer(preview.containerId).catch(() => null) : null;
  if (state?.running && preview.buildId === stable.id) return;

  const name = `ams-run-${previewSlug(preview.project.name)}`;
  await removeContainer(name).catch(() => undefined);
  if (preview.containerId) await removeContainer(preview.containerId).catch(() => undefined);
  const outDir = (/^Site em (\w+)\//.exec(stable.log)?.[1]) ?? 'dist';
  try {
    const containerId = await createContainer({
      image: SERVER_IMAGE,
      name,
      cmd: ['caddy', 'file-server', '--root', '/srv', '--listen', ':80'],
      network: config.agentNetwork,
      labels: { [LABEL]: projectId },
      binds: [`${buildHostDir(projectId, stable.commit)}/src/${outDir}:/srv:ro`],
    });
    await startContainer(containerId);
    await prisma.projectPreview.update({ where: { projectId }, data: { containerId, buildId: stable.id, error: null } });
  } catch (error) {
    await prisma.projectPreview.update({
      where: { projectId },
      data: { containerId: null, error: error instanceof Error ? error.message : String(error) },
    });
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
  const root = path.posix.join(config.agentsDir, PREVIEWS_DIR, projectId);
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (!keep.has(entry)) await rm(path.posix.join(root, entry), { recursive: true, force: true });
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
  const preview = await prisma.projectPreview.findUnique({ where: { projectId }, include: { project: true } });
  if (preview?.containerId) await removeContainer(preview.containerId).catch(() => undefined);
  if (preview) await removeContainer(`ams-run-${previewSlug(preview.project.name)}`).catch(() => undefined);
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
