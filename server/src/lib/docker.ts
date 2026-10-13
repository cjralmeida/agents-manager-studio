import http from 'node:http';

const SOCKET_PATH = '/var/run/docker.sock';

export class DockerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface DockerResponse {
  status: number;
  body: Buffer;
}

/** Minimal Docker Engine API client over the unix socket (only the endpoints the app uses). */
function request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        method,
        path,
        timeout: timeoutMs,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Docker request timed out: ${method} ${path}`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const response = await request(method, path, body, timeoutMs);
  if (response.status >= 400) {
    const text = response.body.toString('utf8');
    const message = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        return text;
      }
    })();
    throw new DockerError(response.status, message);
  }
  if (response.body.length === 0) return undefined as T;
  return JSON.parse(response.body.toString('utf8')) as T;
}

/** Ignores "not found" (404) and "already in that state" (304) answers. */
function ignoreGone(error: unknown) {
  if (error instanceof DockerError && (error.statusCode === 404 || error.statusCode === 304)) return;
  throw error;
}

/**
 * Splits a non-TTY log stream: each frame has an 8-byte header
 * (byte 0 = stream: 1 stdout, 2 stderr; bytes 4-7 = big-endian payload size).
 */
export function demuxLogs(buffer: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const frame = buffer.subarray(offset + 8, offset + 8 + size);
    (stream === 2 ? stderr : stdout).push(frame);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

export async function imageExists(image: string) {
  try {
    await call('GET', `/images/${encodeURIComponent(image)}/json`);
    return true;
  } catch (error) {
    if (error instanceof DockerError && error.statusCode === 404) return false;
    throw error;
  }
}

export interface ContainerMount {
  Type: 'bind' | 'volume';
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

export interface ContainerSpec {
  image: string;
  cmd: string[];
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** Volume or bind mounts, e.g. "volume-name:/home/node/.claude" or "D:/path:/workspace". */
  binds?: string[];
  /** Mounts the bind strings cannot express, e.g. a folder inside a volume (VolumeOptions.Subpath). */
  mounts?: ContainerMount[];
  network?: string;
  /** User inside the container (e.g. "0" for root); empty keeps the image's. */
  user?: string;
}

export async function createContainer(spec: ContainerSpec): Promise<string> {
  const query = spec.name ? `?name=${encodeURIComponent(spec.name)}` : '';
  const { Id } = await call<{ Id: string }>('POST', `/containers/create${query}`, {
    Image: spec.image,
    Cmd: spec.cmd,
    Env: Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: spec.labels ?? {},
    ...(spec.user && { User: spec.user }),
    Tty: false,
    HostConfig: { Binds: spec.binds ?? [], ...(spec.mounts && { Mounts: spec.mounts }), ...(spec.network && { NetworkMode: spec.network }) },
  });
  return Id;
}

export async function startContainer(id: string) {
  await call('POST', `/containers/${id}/start`);
}

/** Sends SIGTERM and kills after the grace period. Missing or stopped containers are ignored. */
export async function stopContainer(id: string, graceSeconds = 10) {
  await call('POST', `/containers/${id}/stop?t=${graceSeconds}`, undefined, (graceSeconds + 10) * 1000).catch(
    ignoreGone,
  );
}

export async function removeContainer(id: string) {
  await call('DELETE', `/containers/${id}?force=1`).catch(ignoreGone);
}

export interface ContainerState {
  running: boolean;
  exitCode: number;
}

/** Null when the container no longer exists. */
export async function inspectContainer(id: string): Promise<ContainerState | null> {
  try {
    const info = await call<{ State: { Running: boolean; ExitCode: number } }>('GET', `/containers/${id}/json`);
    return { running: info.State.Running, exitCode: info.State.ExitCode };
  } catch (error) {
    if (error instanceof DockerError && error.statusCode === 404) return null;
    throw error;
  }
}

/** Labels of a container (e.g. the compose working dir of the server itself); null when it does not exist. */
export async function containerLabels(id: string): Promise<Record<string, string> | null> {
  try {
    const info = await call<{ Config: { Labels: Record<string, string> | null } }>('GET', `/containers/${id}/json`);
    return info.Config.Labels ?? {};
  } catch (error) {
    if (error instanceof DockerError && error.statusCode === 404) return null;
    throw error;
  }
}

export async function containerLogs(id: string, tail = 200) {
  const logs = await request('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`);
  return demuxLogs(logs.body);
}

/** TCP ports an image declares with EXPOSE, in order (e.g. [3000]). */
export async function imageExposedPorts(image: string): Promise<number[]> {
  const info = await call<{ Config: { ExposedPorts?: Record<string, unknown> | null } }>('GET', `/images/${encodeURIComponent(image)}/json`);
  return Object.keys(info.Config.ExposedPorts ?? {})
    .filter((key) => key.endsWith('/tcp'))
    .map((key) => Number(key.split('/')[0]));
}

/** Networks created by a docker compose project (e.g. "myproject_default"). */
export async function composeNetworks(project: string): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  const networks = await call<{ Name: string }[]>('GET', `/networks?filters=${filters}`);
  return networks.map((network) => network.Name);
}

/** Connects a container to one more network (already connected is fine). */
export async function connectNetwork(network: string, containerId: string) {
  await call('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: containerId }).catch((error: unknown) => {
    if (error instanceof DockerError && error.statusCode === 403 && /already exists/i.test(error.message)) return;
    throw error;
  });
}

/** Deletes an image tag (missing or still in use is ignored). */
export async function removeImage(name: string) {
  await call('DELETE', `/images/${encodeURIComponent(name)}`).catch(() => undefined);
}

export async function volumeExists(name: string) {
  try {
    await call('GET', `/volumes/${encodeURIComponent(name)}`);
    return true;
  } catch (error) {
    if (error instanceof DockerError && error.statusCode === 404) return false;
    throw error;
  }
}

export async function removeVolume(name: string) {
  await call('DELETE', `/volumes/${encodeURIComponent(name)}?force=1`).catch(ignoreGone);
}

export interface RunOnceOptions extends ContainerSpec {
  timeoutMs: number;
}

export interface RunOnceResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a short-lived container to completion and always removes it. */
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const id = await createContainer(options);
  try {
    await startContainer(id);

    let timedOut = false;
    const wait = call<{ StatusCode: number }>('POST', `/containers/${id}/wait`, undefined, options.timeoutMs + 5_000);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), options.timeoutMs));
    const result = await Promise.race([wait, timeout]);
    if (result === null) {
      timedOut = true;
      await call('POST', `/containers/${id}/kill`).catch(() => undefined);
    }

    const logs = await request('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
    return { exitCode: result?.StatusCode ?? null, timedOut, ...demuxLogs(logs.body) };
  } finally {
    await removeContainer(id).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- resource usage

export interface DockerInfo {
  ServerVersion: string;
  OperatingSystem: string;
  NCPU: number;
  /** Memory of the Docker VM (Docker Desktop) or host, in bytes. */
  MemTotal: number;
}

export function dockerInfo() {
  return call<DockerInfo>('GET', '/info');
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Labels: Record<string, string>;
}

export function listRunningContainers() {
  return call<ContainerSummary[]>('GET', '/containers/json');
}

export interface ContainerStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
}

/** One sample; Docker waits ~1s to fill the previous CPU reading, so the CPU percentage can be computed. */
export function containerStats(id: string) {
  return call<ContainerStats>('GET', `/containers/${id}/stats?stream=false`, undefined, 15_000);
}

export interface DiskUsage {
  Images?: { Id: string; RepoTags?: string[] | null; Size?: number }[];
  Containers?: { ImageID?: string; SizeRw?: number; Labels?: Record<string, string> | null }[];
  Volumes?: { Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number } }[];
}

/** Can take a few seconds on large installations. */
export function diskUsage() {
  return call<DiskUsage>('GET', '/system/df', undefined, 60_000);
}
