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
      return toDeploy(await call('POST', `/services/${serviceId}/deploys`, { clearCache: 'do_not_clear', ...(commitId && { commitId }) }));
    },

    async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
      return toDeploy(await call('GET', `/services/${serviceId}/deploys/${deployId}`));
    },
  };
}
