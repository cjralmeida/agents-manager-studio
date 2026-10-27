import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { parseInput } from '../../lib/validation.js';
import { requireAdmin } from '../auth/guard.js';
import { resourceOverview, settingsProblem } from '../agents/resource-advice.js';
import { type ResourceSettings, SIZE_NAMES, limitRunningAgents, mapSizes, saveResourceSettings } from '../agents/resources.js';
import { getDiskUsage, getResourceUsage, getWorkspaceDiskUsage, getWorkspaceResourceUsage } from './service.js';
import { lastMaintenance } from './maintenance.js';
import { compactionStatus, startCompaction } from './compaction.js';

/** Without workspaceId: everything of the Studio; with it: only what that workspace's agents use. */
const scopeQuery = z.object({ workspaceId: z.uuid().optional() }).strict();

const sizeBody = z.object({ cpus: z.number().min(0.5).max(16), memoryMb: z.number().int().min(512).max(32_768), reserveMb: z.number().int().min(128).max(32_768) }).strict();
const resourceSettingsBody = z
  .object({
    sizes: z.object({ P: sizeBody, M: sizeBody, G: sizeBody, GG: sizeBody }).strict(),
    reservedCpus: z.number().min(0).max(16),
    reservedMemoryMb: z.number().int().min(0).max(32_768),
    cpuOvercommit: z.number().min(1).max(4),
  })
  .strict();
const profileSizeBody = z.object({ size: z.enum(SIZE_NAMES).nullable() }).strict();
const idParams = z.object({ id: z.uuid() }).strict();

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/resources', async (request) => {
    const { workspaceId } = parseInput(scopeQuery, request.query);
    return workspaceId ? getWorkspaceResourceUsage(workspaceId) : getResourceUsage();
  });

  /** Configurações → Recursos: sizes, budget, measured usage and the Gestor de Capacidade's suggestions. */
  app.get('/system/resource-settings', async () => resourceOverview());

  app.put('/system/resource-settings', async (request) => {
    requireAdmin(request);
    const body = parseInput(resourceSettingsBody, request.body);
    const settings: ResourceSettings = { ...body, sizes: mapSizes((name) => ({ ...body.sizes[name], name })) };
    const problem = settingsProblem(settings);
    if (problem) throw new HttpError(422, problem);
    await saveResourceSettings(settings);
    return resourceOverview();
  });

  /** The size of a workspace agent (profile); null goes back to the size of its role. */
  app.put('/system/resource-settings/profiles/:id', async (request) => {
    requireAdmin(request);
    const { id } = parseInput(idParams, request.params);
    const { size } = parseInput(profileSizeBody, request.body);
    const updated = await prisma.agentProfile.updateMany({ where: { id }, data: { resourceSize: size } });
    if (updated.count === 0) throw notFound('Agente do workspace não encontrado.');
    await limitRunningAgents().catch(() => undefined);
    return resourceOverview();
  });

  app.get('/system/maintenance', async () => lastMaintenance());

  app.get('/system/compaction', async () => compactionStatus());

  app.post('/system/compaction', async (request) => startCompaction(request.user.id, request.log));

  app.get('/system/disk', async (request) => {
    const { workspaceId } = parseInput(scopeQuery, request.query);
    return workspaceId ? getWorkspaceDiskUsage(workspaceId) : getDiskUsage();
  });
}
