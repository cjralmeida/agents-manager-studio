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

export interface RunOnceOptions {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
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
  const { Id: id } = await call<{ Id: string }>('POST', '/containers/create', {
    Image: options.image,
    Cmd: options.cmd,
    Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: options.labels ?? {},
    Tty: false,
  });

  try {
    await call('POST', `/containers/${id}/start`);

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
    await call('DELETE', `/containers/${id}?force=1`).catch(() => undefined);
  }
}
