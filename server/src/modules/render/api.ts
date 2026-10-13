import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';

export interface RenderServiceInfo {
  id: string;
  name: string;
  type: string;
  repo: string | null;
  branch: string | null;
  url: string | null;
  dashboardUrl: string | null;
}

export interface RenderDeploy {
  id: string;
  status: string;
  commitId: string | null;
}

export interface RenderServiceDetails {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  branch: string | null;
  rootDir: string | null;
  autoDeploy: boolean;
  suspended: boolean;
  url: string | null;
  runtime: string | null;
  plan: string | null;
  region: string | null;
  healthCheckPath: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  preDeployCommand: string | null;
  dockerfilePath: string | null;
  dockerCommand: string | null;
}

type Json = any; // Render responses are narrowed where they are read.

export function createRenderClient(apiKey: string) {
  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${config.renderApiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response) throw new HttpError(502, 'Não foi possível conectar ao Render.');
    if (response.status === 401 || response.status === 403) throw new HttpError(422, 'Chave de API do Render inválida ou sem permissão.');
    const data = (await response.json().catch(() => null)) as Json;
    if (!response.ok) throw new HttpError(502, `Render: ${data?.message ?? `erro ${response.status}`}`);
    return data as T;
  }

  const toDeploy = (deploy: Json): RenderDeploy => ({
    id: deploy.id,
    status: deploy.status,
    commitId: deploy.commit?.id ?? null,
  });

  return {
    /** Workspaces/teams the key can see; also proves the key works. */
    async owners() {
      const rows = await call<Json[]>('GET', '/owners?limit=20');
      return rows.map((row) => ({ id: row.owner.id as string, name: row.owner.name as string }));
    },

    async services(): Promise<RenderServiceInfo[]> {
      const services: RenderServiceInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = await call<Json[]>('GET', `/services?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const row of rows) {
          const service = row.service;
          services.push({
            id: service.id,
            name: service.name,
            type: service.type,
            repo: service.repo ?? null,
            branch: service.branch ?? null,
            url: service.serviceDetails?.url ?? null,
            dashboardUrl: service.dashboardUrl ?? null,
          });
        }
        if (rows.length < 100) break;
        cursor = rows.at(-1)?.cursor;
      }
      return services;
    },

    async deploy(serviceId: string, commitId?: string): Promise<RenderDeploy> {
      const created = await call('POST', `/services/${serviceId}/deploys`, { clearCache: 'do_not_clear', ...(commitId && { commitId }) });
      if (created?.id) return toDeploy(created);
      // 202 without a body: the deploy was queued behind one already running (e.g. the auto-deploy the merge just
      // triggered). The newest deploy of the service is the one that will carry the commit.
      const [latest] = await call<Json[]>('GET', `/services/${serviceId}/deploys?limit=1`);
      if (!latest?.deploy?.id) throw new HttpError(502, 'O Render aceitou o deploy, mas não informou qual é.');
      return toDeploy(latest.deploy);
    },

    async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
      return toDeploy(await call('GET', `/services/${serviceId}/deploys/${deployId}`));
    },

    /** How the service builds and runs (what an agent checks before deploying). */
    async serviceDetails(serviceId: string): Promise<RenderServiceDetails> {
      const service = await call('GET', `/services/${serviceId}`);
      const details = service.serviceDetails ?? {};
      const commands = details.envSpecificDetails ?? {};
      return {
        id: service.id,
        name: service.name,
        ownerId: service.ownerId,
        type: service.type,
        branch: service.branch ?? null,
        rootDir: service.rootDir || null,
        autoDeploy: service.autoDeploy === 'yes',
        suspended: service.suspended === 'suspended',
        url: details.url ?? null,
        runtime: details.runtime ?? details.env ?? null,
        plan: details.plan ?? null,
        region: details.region ?? null,
        healthCheckPath: details.healthCheckPath || null,
        buildCommand: commands.buildCommand ?? null,
        startCommand: commands.startCommand ?? null,
        preDeployCommand: details.preDeployCommand ?? commands.preDeployCommand ?? null,
        dockerfilePath: commands.dockerfilePath ?? null,
        dockerCommand: commands.dockerCommand ?? null,
      };
    },

    /** Names of the service's environment variables (values are never read back). */
    async envVarKeys(serviceId: string): Promise<string[]> {
      const rows = await call<Json[]>('GET', `/services/${serviceId}/env-vars?limit=100`);
      return rows.map((row) => row.envVar?.key as string).filter(Boolean);
    },

    /** Creates or replaces a variable with a value, or one Render generates (a random secret nobody sees). */
    async setEnvVar(serviceId: string, key: string, value: { value: string } | { generateValue: true }) {
      await call('PUT', `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, value);
    },

    /** Most recent log lines of a service (build, app or request logs), newest last. */
    async logs(input: { ownerId: string; serviceId: string; type: 'build' | 'app' | 'request'; limit: number; text?: string }) {
      const query = new URLSearchParams({
        ownerId: input.ownerId,
        resource: input.serviceId,
        type: input.type,
        limit: String(input.limit),
        direction: 'backward',
        ...(input.text && { text: input.text }),
      });
      const data = await call<Json>('GET', `/logs?${query}`);
      const lines: { timestamp: string; message: string }[] = (data?.logs ?? []).map((log: Json) => ({
        timestamp: log.timestamp,
        message: log.message,
      }));
      return lines.reverse();
    },
  };
}
