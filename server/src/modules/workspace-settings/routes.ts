import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { copyWorkspaceSettings, getWorkspaceSettings, updateWorkspaceSettings } from './service.js';

const idParams = z.object({ id: z.uuid() });

const settingsBody = z
  .object({
    agentAccountId: z.uuid().nullable(),
    renderAccountId: z.uuid().nullable().default(null),
    clickupAccountId: z.uuid().nullable().default(null),
    /** Left out = unchanged (screens that do not show it keep the account). */
    pixellabAccountId: z.uuid().nullable().optional(),
    gitAccountIds: z.array(z.uuid()).max(20),
    enabledSkillIds: z.array(z.string().min(1).max(300)).max(200),
  })
  .strict()
  .transform((body) => ({
    ...body,
    gitAccountIds: [...new Set(body.gitAccountIds)],
    enabledSkillIds: [...new Set(body.enabledSkillIds)],
  }));

const copyBody = z.object({ targetWorkspaceIds: z.array(z.uuid()).min(1).max(100) }).strict();

export async function workspaceSettingsRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/settings', async (request) =>
    getWorkspaceSettings(parseInput(idParams, request.params).id),
  );

  app.put('/workspaces/:id/settings', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateWorkspaceSettings(id, parseInput(settingsBody, request.body));
  });

  app.post('/workspaces/:id/settings/copy', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { targetWorkspaceIds } = parseInput(copyBody, request.body);
    return copyWorkspaceSettings(id, targetWorkspaceIds);
  });
}
