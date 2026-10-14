import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { config } from '../../config.js';
import {
  composeNetworks,
  connectNetwork,
  containerLogs,
  createContainer,
  imageExposedPorts,
  inspectContainer,
  removeContainer,
  runOnce,
  startContainer,
} from '../../lib/docker.js';
import { renderDotenv } from './variables.js';

/**
 * How each kind of project is checked and served. Every kind ends with a small Caddy container named
 * "ams-run-<slug>" on the Studio network, which the proxy reaches at http://<slug>.localhost.
 */

export type PreviewKind = 'static' | 'dockerfile' | 'compose';

export interface Detected {
  kind: PreviewKind;
  /** Compose file name, for "compose". */
  file?: string;
}

export interface CheckResult {
  passed: boolean;
  log: string;
  /** Site folder (static), container port (dockerfile) or "service:port" (compose). */
  target?: string;
}

export interface Workspace {
  projectId: string;
  slug: string;
  /** Checked-out source, as the server sees it and as the Docker daemon sees it. */
  src: string;
  srcHost: string;
  commit: string;
  /** The project's variables (build, tests and the running app). */
  env: Record<string, string>;
}

const CADDY_IMAGE = 'caddy:2.10-alpine';
const CLI_IMAGE = 'docker:28-cli';
export const PREVIEW_LABEL = 'studio.preview';
const CHECK_TIMEOUT_MS = 15 * 60_000;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OUTPUT_DIRS = ['dist', 'build', 'out'];
/** Extra compose file the Studio writes: no published ports (they could clash with the machine's) and no fixed names. */
const OVERRIDE_FILE = '.studio-rodar.yml';
/** The project's variables for docker compose (every service gets them, and ${VAR} in the file reads them). */
const ENV_FILE = '.studio-rodar.env';

const exists = (file: string) => stat(file).then(() => true, () => false);
const output = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`.trim();
export const runName = (slug: string) => `ams-run-${slug}`;
const appName = (slug: string) => `ams-app-${slug}`;
const imageTag = (slug: string, commit: string) => `ams-preview-${slug}:${commit.slice(0, 12)}`;

/** Path as the Docker daemon sees it: on Docker Desktop, "D:/x" is "/run/desktop/mnt/host/d/x". */
export function daemonPath(hostPath: string) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  return drive ? `/run/desktop/mnt/host/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}` : hostPath;
}

/** Runs the docker CLI (with compose and buildx) against the Studio's Docker, inside the checked-out source. */
export function dockerCli(ws: Pick<Workspace, 'projectId' | 'slug' | 'srcHost'>, script: string, timeoutMs = CHECK_TIMEOUT_MS) {
  const inside = daemonPath(ws.srcHost);
  return runOnce({
    image: CLI_IMAGE,
    name: `ams-cli-${ws.slug}-${Date.now().toString(36)}`,
    cmd: ['sh', '-c', `cd '${inside}' && ${script}`],
    labels: { [PREVIEW_LABEL]: ws.projectId },
    binds: ['/var/run/docker.sock:/var/run/docker.sock', `${ws.srcHost}:${inside}`],
    timeoutMs,
  });
}

export async function detect(src: string): Promise<Detected | null> {
  for (const file of COMPOSE_FILES) if (await exists(`${src}/${file}`)) return { kind: 'compose', file };
  if (await exists(`${src}/Dockerfile`)) return { kind: 'dockerfile' };
  const pkg = await readFile(`${src}/package.json`, 'utf8').then((text) => JSON.parse(text) as { scripts?: Record<string, string> }, () => null);
  if (pkg?.scripts?.build) return { kind: 'static' };
  return null;
}

export const UNSUPPORTED =
  'O Rodar não encontrou como rodar este projeto. Ele precisa de um destes na raiz do repositório: um docker-compose.yml ' +
  '(ou compose.yaml), um Dockerfile, ou um package.json com o script "build" que gere um site estático (ex.: Vite em dist/).';

// ---------------------------------------------------------------- checks

/** Node project with a static build: install, build and tests in the runner image; the site comes from dist/build/out. */
async function checkStatic(ws: Workspace): Promise<CheckResult> {
  const result = await runOnce({
    image: config.agentRunnerImage,
    name: `ams-check-${ws.slug}-${Date.now().toString(36)}`,
    cmd: ['sh', '-c', 'cd /app && npm ci --no-audit --no-fund && npm run build && npm test --if-present'],
    user: '0',
    env: { ...ws.env, CI: 'true', npm_config_update_notifier: 'false' },
    labels: { [PREVIEW_LABEL]: ws.projectId },
    binds: [`${ws.srcHost}:/app`],
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  const log = output(result);
  if (result.timedOut) return { passed: false, log: `A verificação passou de ${CHECK_TIMEOUT_MS / 60_000} minutos.\n\n${log}` };
  if (result.exitCode !== 0) return { passed: false, log: log || `Saiu com código ${result.exitCode}.` };
  for (const dir of OUTPUT_DIRS) {
    if (await exists(`${ws.src}/${dir}/index.html`)) return { passed: true, log: `Site em ${dir}/.\n\n${log}`, target: dir };
  }
  return { passed: false, log: `O build passou, mas não gerou ${OUTPUT_DIRS.map((dir) => `${dir}/index.html`).join(' nem ')}.\n\n${log}` };
}

/** Ports an app usually listens on, tried first; 443 (TLS) and 2019 (Caddy's admin) never serve the app over HTTP. */
const USUAL_PORTS = [80, 8080, 3000, 8000, 5000, 4173, 5173, 4200, 8888];

/**
 * Ports to try, best first. Base images declare their own ports too (e.g. Caddy: 80, 443, 2019), and Docker gives
 * them in no particular order, so the right one is the first that answers.
 */
export function candidatePorts(exposed: number[]) {
  const usable = exposed.filter((port) => port !== 443 && port !== 2019);
  const rank = (port: number) => (USUAL_PORTS.includes(port) ? USUAL_PORTS.indexOf(port) : USUAL_PORTS.length + port);
  const sorted = [...new Set(usable)].sort((a, b) => rank(a) - rank(b));
  return sorted.length > 0 ? sorted : [80];
}

/** The first port that answers HTTP at all (any status), retrying while the app boots. */
async function firstAnsweringPort(host: string, ports: number[], seconds = 40) {
  const deadline = Date.now() + seconds * 1000;
  let error = '';
  while (Date.now() < deadline) {
    for (const port of ports) {
      try {
        await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3_000), redirect: 'manual' });
        return { port, error: '' };
      } catch (cause) {
        error = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { port: null, error: error || 'sem resposta' };
}

/** Dockerfile: builds the image, starts it and checks that it stays up and answers HTTP on its port. */
async function checkDockerfile(ws: Workspace): Promise<CheckResult> {
  const tag = imageTag(ws.slug, ws.commit);
  const build = await dockerCli(ws, `docker build --progress=plain -t ${tag} .`);
  if (build.timedOut || build.exitCode !== 0) return { passed: false, log: `O docker build falhou.\n\n${output(build)}` };

  const ports = candidatePorts(await imageExposedPorts(tag));
  const name = `ams-check-${ws.slug}`;
  await removeContainer(name).catch(() => undefined);
  const id = await createContainer({ image: tag, name, cmd: [], env: ws.env, network: config.agentNetwork, labels: { [PREVIEW_LABEL]: ws.projectId } });
  try {
    await startContainer(id);
    const answer = await firstAnsweringPort(name, ports);
    const state = await inspectContainer(id);
    if (!state?.running || !answer.port) {
      const logs = await containerLogs(id, 80).catch(() => ({ stdout: '', stderr: '' }));
      const why = !state?.running
        ? `O container parou (código ${state?.exitCode ?? '?'}).`
        : `O container não respondeu HTTP em nenhuma porta (${ports.join(', ')}): ${answer.error}.`;
      return { passed: false, log: `${why} Declare a porta do app com EXPOSE no Dockerfile.\n\n${output(logs)}\n\n${output(build).slice(-1500)}` };
    }
    const port = answer.port;
    return { passed: true, log: `Imagem ${tag}, respondendo na porta ${port}.\n\n${output(build).slice(-2000)}`, target: String(port) };
  } finally {
    await removeContainer(id).catch(() => undefined);
  }
}

interface ComposeService {
  ports?: { target: number }[];
  expose?: (string | number)[];
  labels?: Record<string, string>;
}

/** The service and port "Rodar" opens: the one labeled studio.rodar, else the first that publishes or exposes a port. */
export function pickService(services: Record<string, ComposeService>) {
  const entries = Object.entries(services);
  const labeled = entries.find(([, service]) => service.labels?.['studio.rodar']);
  const portOf = (service: ComposeService) => {
    const label = Number(service.labels?.['studio.rodar']);
    if (Number.isInteger(label) && label > 0) return label;
    return service.ports?.[0]?.target ?? (service.expose?.[0] !== undefined ? Number(String(service.expose[0]).split('/')[0]) : null);
  };
  for (const [name, service] of labeled ? [labeled] : entries) {
    const port = portOf(service);
    if (port) return { service: name, port };
  }
  return null;
}

/**
 * Writes the variables file and the override (no published ports, no fixed names, variables in every service) and
 * returns the compose flags plus the service to open.
 */
async function prepareCompose(ws: Workspace, file: string) {
  await writeFile(`${ws.src}/${ENV_FILE}`, renderDotenv(ws.env));
  await chmod(`${ws.src}/${ENV_FILE}`, 0o600);
  // --env-file replaces the project's own .env, so both are passed (ours wins).
  const envFiles = `${(await exists(`${ws.src}/.env`)) ? '--env-file .env ' : ''}--env-file ${ENV_FILE}`;
  const config = await dockerCli(ws, `docker compose ${envFiles} -f ${file} config --format json`, 120_000);
  if (config.exitCode !== 0) return { error: `O docker-compose não é válido.\n\n${output(config)}` };
  const services = (JSON.parse(config.stdout) as { services: Record<string, ComposeService> }).services;
  const target = pickService(services);
  if (!target) {
    return { error: 'Nenhum serviço do compose publica ou expõe uma porta. Marque o serviço que o Rodar deve abrir com o label studio.rodar: "<porta>".' };
  }
  const withEnv = Object.keys(ws.env).length > 0;
  const lines = [
    'services:',
    ...Object.keys(services).flatMap((name) => [
      `  ${JSON.stringify(name)}:`,
      '    ports: !reset []',
      '    container_name: !reset null',
      ...(withEnv ? ['    env_file:', `      - ${ENV_FILE}`] : []),
    ]),
  ];
  await writeFile(`${ws.src}/${OVERRIDE_FILE}`, `${lines.join('\n')}\n`);
  return { target, flags: `${envFiles} -f ${file} -f ${OVERRIDE_FILE}` };
}

/** docker compose: brings the whole stack up (built, healthy) under a check name, then takes it down. */
async function checkCompose(ws: Workspace, file: string): Promise<CheckResult> {
  const prepared = await prepareCompose(ws, file);
  if ('error' in prepared) return { passed: false, log: prepared.error ?? '' };
  const project = `ams-check-${ws.slug}`;
  const compose = `docker compose ${prepared.flags} -p ${project}`;
  const result = await dockerCli(
    ws,
    `${compose} up -d --build --wait --wait-timeout 240; code=$?; ` +
      `if [ $code -ne 0 ]; then ${compose} ps -a; ${compose} logs --no-color --tail 60; fi; ` +
      `${compose} down -v --remove-orphans --rmi local >/dev/null 2>&1; exit $code`,
  );
  const { service, port } = prepared.target;
  if (result.timedOut || result.exitCode !== 0) return { passed: false, log: `A stack não subiu saudável.\n\n${output(result)}` };
  return { passed: true, log: `Stack saudável; o Rodar abre ${service}:${port}.\n\n${output(result).slice(-2500)}`, target: `${service}:${port}` };
}

export function runCheck(ws: Workspace, detected: Detected): Promise<CheckResult> {
  if (detected.kind === 'compose') return checkCompose(ws, detected.file!);
  if (detected.kind === 'dockerfile') return checkDockerfile(ws);
  return checkStatic(ws);
}

// ---------------------------------------------------------------- serving

/** The Caddy container the proxy reaches: serves files, or forwards to the app. */
async function startFront(ws: Pick<Workspace, 'projectId' | 'slug'>, front: { files?: string; upstream?: string; networks?: string[] }) {
  const name = runName(ws.slug);
  await removeContainer(name).catch(() => undefined);
  const id = await createContainer({
    image: CADDY_IMAGE,
    name,
    cmd: front.files ? ['caddy', 'file-server', '--root', '/srv', '--listen', ':80'] : ['caddy', 'reverse-proxy', '--from', ':80', '--to', front.upstream!],
    network: config.agentNetwork,
    labels: { [PREVIEW_LABEL]: ws.projectId },
    binds: front.files ? [`${front.files}:/srv:ro`] : [],
  });
  for (const network of front.networks ?? []) await connectNetwork(network, id);
  await startContainer(id);
  return id;
}

/** Puts the checked build up; returns the id of the front container. */
export async function serve(ws: Workspace, kind: PreviewKind, target: string | null): Promise<string> {
  if (kind === 'static') return startFront(ws, { files: `${ws.srcHost}/${target ?? 'dist'}` });

  if (kind === 'dockerfile') {
    const app = appName(ws.slug);
    await removeContainer(app).catch(() => undefined);
    const id = await createContainer({
      image: imageTag(ws.slug, ws.commit),
      name: app,
      cmd: [],
      env: ws.env,
      network: config.agentNetwork,
      labels: { [PREVIEW_LABEL]: ws.projectId },
    });
    await startContainer(id);
    return startFront(ws, { upstream: `${app}:${target ?? '80'}` });
  }

  const file = (await detect(ws.src))?.file;
  if (!file || !target) throw new Error('O build estável não tem o compose ou o serviço a abrir.');
  // Prepared again: the variables may have changed since the check.
  const prepared = await prepareCompose(ws, file);
  if ('error' in prepared) throw new Error(prepared.error);
  const project = runName(ws.slug);
  const up = await dockerCli(ws, `docker compose ${prepared.flags} -p ${project} up -d --build --wait --wait-timeout 240 --remove-orphans`);
  if (up.timedOut || up.exitCode !== 0) throw new Error(`A stack não subiu.\n\n${output(up).slice(-1500)}`);
  return startFront(ws, { upstream: target, networks: await composeNetworks(project) });
}

/** Takes the project down; compose volumes are kept (the data survives a stop). */
export async function unserve(ws: Pick<Workspace, 'projectId' | 'slug' | 'srcHost'>, kind: PreviewKind | null) {
  await removeContainer(runName(ws.slug)).catch(() => undefined);
  await removeContainer(appName(ws.slug)).catch(() => undefined);
  if (kind === 'compose') await dockerCli(ws, `docker compose -p ${runName(ws.slug)} down --remove-orphans`, 180_000).catch(() => undefined);
}
