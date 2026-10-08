import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getDiskUsage, getResourceUsage, getWorkspaceDiskUsage, getWorkspaceResourceUsage } from './service.js';

/** Without workspaceId: everything of the Studio; with it: only what that workspace's agents use. */
const scopeQuery = z.object({ workspaceId: z.uuid().optional() }).strict();

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/resources', async (request) => {
    const { workspaceId } = parseInput(scopeQuery, request.query);
    return workspaceId ? getWorkspaceResourceUsage(workspaceId) : getResourceUsage();
  });

  app.get('/system/disk', async (request) => {
    const { workspaceId } = parseInput(scopeQuery, request.query);
    return workspaceId ? getWorkspaceDiskUsage(workspaceId) : getDiskUsage();
  });
}
