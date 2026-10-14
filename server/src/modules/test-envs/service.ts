import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { TestEnvironment } from '../../generated/prisma/client.js';
import { composeNetworks, connectNetwork, createContainer, removeContainer, startContainer } from '../../lib/docker.js';
import { HttpError } from '../../lib/errors.js';
import { git } from '../../lib/git.js';
import { dockerCli } from '../previews/runners.js';
import { headCommit, previewSlug, remoteOf } from '../previews/service.js';
import { projectEnv, renderDotenv } from '../previews/variables.js';
import { getResourceUsage } from '../system/service.js';
import { reservationFits } from './capacity.js';

/**
 * Test environments: a throwaway copy of a project running on this machine, for testers when the homologation
 * environment is not usable. Each project describes its own in `docker/test-env/docker-compose.yml` (database with
 * test data, the app built from its Dockerfile...); the services labeled `studio.test: "<port>"` are reached by the
 * agents at http://<name>. An environment only starts when the computer has room for it (the same memory limit as
 * the agents), otherwise it waits in line; it is taken down when its agent is done.
 */

export const TEST_ENV_FILE = 'docker/test-env/docker-compose.yml';
const DIR = '.test-envs';
const OVERRIDE_FILE = '.studio-test.yml';
const ENV_FILE = '.studio-test.env';
const CADDY_IMAGE = 'caddy:2.10-alpine';
const LABEL = 'studio.test-env';
/** Memory reserved per environment when the compose file does not say (label studio.test.memory on a service, MB). */
const DEFAULT_MEMORY_MB = 1536;
const BUILD_TIMEOUT_MS = 30 * 60_000;
/** An environment never outlives this, even if its agent is forgotten. */
const MAX_AGE_MS = 4 * 60 * 60_000;
const TICK_MS = 30_000;
const LOG_TAIL = 4_000;

const short = (id: string) => id.replace(/-/g, '').slice(-10);
const stackName = (env: Pick<TestEnvironment, 'id'>) => `ams-te-${short(env.id)}`;
const frontName = (env: Pick<TestEnvironment, 'id'>, service: string) => `ams-te-${short(env.id)}-${previewSlug(service)}`;
const src = (env: Pick<TestEnvironment, 'id'>) => path.posix.join(config.agentsVolumeDir, DIR, env.id, 'src');
const srcHost = (env: Pick<TestEnvironment, 'id'>) => path.posix.join(config.agentsVolumeDaemonDir, DIR, env.id, 'src');
const cliWorkspace = (env: TestEnvironment) => ({ projectId: env.projectId, slug: stackName(env), srcHost: srcHost(env) });
const tail = (text: string) => (text.length > LOG_TAIL ? `…${text.slice(-LOG_TAIL)}` : text);
const exists = (file: string) => stat(file).then(() => true, () => false);
const ACTIVE = ['queued', 'building', 'ready'];

export interface TestEnvResponse {
  id: string;
  project: string;
  status: string;
  commit: string | null;
  memoryMb: number;
  urls: { service: string; url: string }[];
  error: string | null;
  agentId: string | null;
  createdAt: Date;
  readyAt: Date | null;
}

async function toResponse(env: TestEnvironment): Promise<TestEnvResponse> {
  const project = await prisma.project.findUnique({ where: { id: env.projectId }, select: { name: true } });
  return {
    id: env.id,
    project: project?.name ?? '?',
    status: env.status,
    commit: env.commit,
    memoryMb: env.memoryMb,
    urls: env.urls as { service: string; url: string }[],
    error: env.error,
    agentId: env.agentId,
    createdAt: env.createdAt,
    readyAt: env.readyAt,
  };
}

/** Starts (or queues) an environment of a workspace project for an agent. */
export async function startTestEnv(input: { workspaceId: string; projectName: string; agentId: string | null; variables?: Record<string, string> }, log?: FastifyBaseLogger) {
  const project = await prisma.project.findFirst({
    where: { workspaceId: input.workspaceId, name: { equals: input.projectName.trim(), mode: 'insensitive' } },
  });
  if (!project) {
    const names = (await prisma.project.findMany({ where: { workspaceId: input.workspaceId }, select: { name: true } })).map((entry) => entry.name);
    throw new HttpError(404, `Projeto "${input.projectName}" não existe no workspace. Projetos: ${names.join(', ')}.`);
  }
  const env = await prisma.testEnvironment.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: project.id,
      agentId: input.agentId,
      memoryMb: DEFAULT_MEMORY_MB,
      variables: input.variables ?? {},
    },
  });
  void advance(log);
  return toResponse(env);
}

export async function getTestEnv(id: string) {
  const env = await prisma.testEnvironment.findUnique({ where: { id } });
  if (!env) throw new HttpError(404, 'Ambiente de teste não encontrado.');
  const response = await toResponse(env);
  if (env.status === 'queued') {
    const ahead = await prisma.testEnvironment.count({ where: { status: 'queued', createdAt: { lt: env.createdAt } } });
    return { ...response, message: `Na fila: falta memória livre no computador${ahead > 0 ? ` (${ahead} na frente)` : ''}. Consulte de novo em 1–2 minutos.` };
  }
  if (env.status === 'building') return { ...response, message: 'Subindo (build das imagens e banco). Consulte de novo em 1–2 minutos.' };
  return response;
}

export async function listTestEnvs(filter: { workspaceId?: string; agentId?: string; active?: boolean } = {}) {
  const envs = await prisma.testEnvironment.findMany({
    where: {
      ...(filter.workspaceId && { workspaceId: filter.workspaceId }),
      ...(filter.agentId && { agentId: filter.agentId }),
      ...(filter.active && { status: { in: ACTIVE } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return Promise.all(envs.map(toResponse));
}

/** How many more environments fit now, from the computer's memory and the reservations of those going up. */
export async function testEnvCapacity() {
  const usage = await getResourceUsage();
  const reserved = (await prisma.testEnvironment.findMany({ where: { status: 'building' }, select: { memoryMb: true } })).reduce(
    (total, env) => total + env.memoryMb,
    0,
  );
  const memory = usage.host ? { used: usage.host.memoryUsed, total: usage.host.memoryTotal } : { used: usage.totals.memoryUsed, total: usage.docker.memoryTotal };
  const room = (fits: number) => reservationFits({ ...memory, reservedMb: reserved, limitPercent: config.launchMemoryPercent, envMb: DEFAULT_MEMORY_MB, count: fits });
  let fits = 0;
  while (fits < 10 && room(fits + 1)) fits++;
  const active = await prisma.testEnvironment.count({ where: { status: { in: ['building', 'ready'] } } });
  return { active, fits, memoryMbPerEnv: DEFAULT_MEMORY_MB, limitPercent: config.launchMemoryPercent };
}

async function fail(env: TestEnvironment, error: string, log = '') {
  await prisma.testEnvironment.update({ where: { id: env.id }, data: { status: 'failed', error: error.slice(0, 1000), log: tail(log) } });
  await teardown(env);
}

/** Clones the project's newest commit (base branch), brings its test stack up and exposes the labeled services. */
async function build(env: TestEnvironment, log?: FastifyBaseLogger) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: env.projectId } });
  try {
    const remote = await remoteOf(project);
    const commit = await headCommit(remote.url, remote.branch);
    await rm(path.posix.dirname(src(env)), { recursive: true, force: true });
    await mkdir(path.posix.dirname(src(env)), { recursive: true });
    await git('/tmp', ['clone', '--quiet', '--depth', '1', '--branch', remote.branch, remote.url, src(env)], { timeoutMs: 300_000 });
    await git(src(env), ['remote', 'set-url', 'origin', remote.cleanUrl]);
    await prisma.testEnvironment.update({ where: { id: env.id }, data: { commit } });
    if (!(await exists(`${src(env)}/${TEST_ENV_FILE}`))) {
      return fail(
        env,
        `O projeto ${project.name} ainda não tem ambiente de teste: falta o arquivo ${TEST_ENV_FILE} (banco com dados de teste, o app pelo Dockerfile e o label studio.test: "<porta>" nos serviços que os testes acessam).`,
      );
    }
    const variables = { ...(await projectEnv(project.id)), ...(env.variables as Record<string, string>) };
    await writeFile(`${src(env)}/${ENV_FILE}`, renderDotenv(variables));
    await chmod(`${src(env)}/${ENV_FILE}`, 0o600);
    const cli = cliWorkspace(env);
    const flags = `--env-file ${ENV_FILE} -f ${TEST_ENV_FILE}`;
    const parsed = await dockerCli(cli, `docker compose ${flags} config --format json`, 120_000);
    if (parsed.exitCode !== 0) return fail(env, `O ${TEST_ENV_FILE} não é válido.`, `${parsed.stdout}\n${parsed.stderr}`);
    const services = (JSON.parse(parsed.stdout) as { services: Record<string, { labels?: Record<string, string> }> }).services;
    const exposed = Object.entries(services).flatMap(([name, service]) => {
      const port = Number(service.labels?.['studio.test']);
      return Number.isInteger(port) && port > 0 ? [{ name, port }] : [];
    });
    if (exposed.length === 0) return fail(env, `Nenhum serviço do ${TEST_ENV_FILE} tem o label studio.test: "<porta>".`);
    const memoryMb = Object.values(services).reduce((total, service) => total + (Number(service.labels?.['studio.test.memory']) || 0), 0);
    if (memoryMb > 0) await prisma.testEnvironment.update({ where: { id: env.id }, data: { memoryMb } });
    // No published ports (they could clash with the machine's) and no fixed container names.
    await writeFile(
      `${src(env)}/${OVERRIDE_FILE}`,
      ['services:', ...Object.keys(services).flatMap((name) => [`  ${JSON.stringify(name)}:`, '    ports: !reset []', '    container_name: !reset null'])].join('\n') + '\n',
    );
    const compose = `docker compose ${flags} -f ${OVERRIDE_FILE} -p ${stackName(env)}`;
    const up = await dockerCli(
      cli,
      `${compose} up -d --build --wait --wait-timeout 900; code=$?; if [ $code -ne 0 ]; then ${compose} ps -a; ${compose} logs --no-color --tail 80; fi; exit $code`,
      BUILD_TIMEOUT_MS,
    );
    if (up.timedOut || up.exitCode !== 0) return fail(env, 'A stack de teste não subiu saudável.', `${up.stdout}\n${up.stderr}`);
    const networks = await composeNetworks(stackName(env));
    const urls: { service: string; url: string }[] = [];
    for (const { name, port } of exposed) {
      const front = frontName(env, name);
      await removeContainer(front).catch(() => undefined);
      const id = await createContainer({
        image: CADDY_IMAGE,
        name: front,
        cmd: ['caddy', 'reverse-proxy', '--from', ':80', '--to', `${name}:${port}`],
        network: config.agentNetwork,
        labels: { [LABEL]: env.id },
      });
      for (const network of networks) await connectNetwork(network, id);
      await startContainer(id);
      urls.push({ service: name, url: `http://${front}` });
    }
    await prisma.testEnvironment.update({
      where: { id: env.id },
      data: { status: 'ready', urls, readyAt: new Date(), log: tail(`${up.stdout}\n${up.stderr}`) },
    });
    log?.info({ envId: env.id, project: project.name }, 'Test environment ready');
  } catch (error) {
    await fail(env, error instanceof Error ? error.message : String(error));
  }
}

/** Takes an environment down: its fronts, the stack with its volumes and built images, and the cloned source. */
async function teardown(env: TestEnvironment) {
  const urls = (env.urls as { service: string }[]) ?? [];
  for (const { service } of urls) await removeContainer(frontName(env, service)).catch(() => undefined);
  if (await exists(src(env))) {
    await dockerCli(cliWorkspace(env), `docker compose -p ${stackName(env)} down -v --remove-orphans --rmi local`, 300_000).catch(() => undefined);
  }
  await rm(path.posix.dirname(src(env)), { recursive: true, force: true }).catch(() => undefined);
}

export async function stopTestEnv(id: string) {
  const env = await prisma.testEnvironment.findUnique({ where: { id } });
  if (!env) throw new HttpError(404, 'Ambiente de teste não encontrado.');
  if (!ACTIVE.includes(env.status)) return toResponse(env);
  const stopped = await prisma.testEnvironment.update({ where: { id }, data: { status: 'stopped', stoppedAt: new Date() } });
  void teardown(env);
  return toResponse(stopped);
}

let advancing = false;

/** Starts queued environments while there is room (oldest first), one build at a time. */
async function advance(log?: FastifyBaseLogger) {
  if (advancing) return;
  advancing = true;
  try {
    for (;;) {
      const next = await prisma.testEnvironment.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } });
      if (!next) return;
      const building = await prisma.testEnvironment.count({ where: { status: 'building' } });
      if (building > 0) return;
      const { fits } = await testEnvCapacity();
      if (fits < 1) return;
      const env = await prisma.testEnvironment.update({ where: { id: next.id }, data: { status: 'building' } });
      await build(env, log);
    }
  } finally {
    advancing = false;
  }
}

/** Environments whose agent is done (or that got too old) are taken down; queued ones start when there is room. */
async function tick(log: FastifyBaseLogger) {
  const active = await prisma.testEnvironment.findMany({ where: { status: { in: ACTIVE } } });
  for (const env of active) {
    const agent = env.agentId ? await prisma.agent.findUnique({ where: { id: env.agentId }, select: { status: true } }) : null;
    const agentDone = env.agentId && (!agent || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(agent.status));
    const tooOld = Date.now() - env.createdAt.getTime() > MAX_AGE_MS;
    if (agentDone || tooOld) {
      await stopTestEnv(env.id).catch(() => undefined);
      log.info({ envId: env.id, reason: agentDone ? 'agent done' : 'too old' }, 'Test environment taken down');
    }
  }
  await advance(log);
}

export function startTestEnvMonitor(log: FastifyBaseLogger) {
  // Environments left building by a restart are given up; their agent asks again.
  void prisma.testEnvironment
    .findMany({ where: { status: 'building' } })
    .then((envs) => Promise.all(envs.map((env) => fail(env, 'O Studio reiniciou enquanto o ambiente subia; peça de novo.'))))
    .catch(() => undefined);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(log)
      .catch((err: unknown) => log.error({ err }, 'Test environment tick failed'))
      .finally(() => (running = false));
  }, TICK_MS);
  return () => clearInterval(timer);
}
