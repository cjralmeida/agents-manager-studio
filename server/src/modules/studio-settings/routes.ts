import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getHostHelper, requestProjectsRoot } from './host-helper.js';
import { getStudioSettings, updateStudioSettings } from './service.js';

const projectsRootBody = z.object({ hostPath: z.string().max(500), excluded: z.array(z.string().max(100)).max(50) }).strict();
const settingsBody = z.object({ githubBoardTemplateUrl: z.string().trim().max(500).nullable() }).strict();

export async function studioSettingsRoutes(app: FastifyInstance) {
  app.get('/studio-settings', async () => getStudioSettings());

  app.put('/studio-settings', async (request) => updateStudioSettings(parseInput(settingsBody, request.body)));

  /** The Windows helper (studio.ps1): whether it runs and how the last request went. */
  app.get('/host-helper', async () => getHostHelper());

  app.post('/studio-settings/projects-root', async (request) => requestProjectsRoot(parseInput(projectsRootBody, request.body)));
}
