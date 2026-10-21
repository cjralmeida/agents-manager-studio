import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { forgetHistory } from './metrics.js';
import { workspaceRoadmaps } from './service.js';
import { roadmapSettings, roadmapSettingsSchema, saveRoadmapSettings } from './settings.js';
import { saveSystemsSettings, systemsSchema, systemsSettings } from './systems.js';

const workspaceParams = z.object({ id: z.uuid() });
const roadmapQuery = z.object({ refresh: z.stringbool().default(false) }).strict();

export async function roadmapRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/roadmaps', async (request) =>
    workspaceRoadmaps(parseInput(workspaceParams, request.params).id, parseInput(roadmapQuery, request.query).refresh),
  );

  /** Working calendar and pauses the roadmap counts time with. */
  app.get('/workspaces/:id/roadmap-settings', async (request) => roadmapSettings(parseInput(workspaceParams, request.params).id));

  app.put('/workspaces/:id/roadmap-settings', async (request) => {
    const saved = await saveRoadmapSettings(parseInput(workspaceParams, request.params).id, parseInput(roadmapSettingsSchema, request.body));
    forgetHistory();
    return saved;
  });

  /** The workspace's systems: their projects and where their documentation and roadmap live. */
  app.get('/workspaces/:id/systems', async (request) => systemsSettings(parseInput(workspaceParams, request.params).id));

  app.put('/workspaces/:id/systems', async (request) =>
    saveSystemsSettings(parseInput(workspaceParams, request.params).id, parseInput(systemsSchema, request.body)),
  );
}
