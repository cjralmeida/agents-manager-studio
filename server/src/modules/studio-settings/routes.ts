import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { requireAdmin } from '../auth/guard.js';
import { getHostHelper, requestProjectsRoot } from './host-helper.js';
import { getStudioSettings, updateStudioSettings } from './service.js';

const projectsRootBody = z.object({ hostPath: z.string().max(500), excluded: z.array(z.string().max(100)).max(50) }).strict();
const settingsBody = z.object({ githubBoardTemplateUrl: z.string().trim().max(500).nullable() }).strict();

export async function studioSettingsRoutes(app: FastifyInstance) {
  app.get('/studio-settings', async (request) => getStudioSettings(request.user.id));

  app.put('/studio-settings', async (request) => updateStudioSettings(request.user.id, parseInput(settingsBody, request.body)));

  /** The Windows helper (studio.ps1): whether it runs and how the last request went. */
  /** Changing the central folder restarts the Studio for everyone: administrators only. */
  app.get('/host-helper', async (request) => {
    requireAdmin(request);
    return getHostHelper();
  });

  app.post('/studio-settings/projects-root', async (request) => {
    requireAdmin(request);
    return requestProjectsRoot(parseInput(projectsRootBody, request.body));
  });
}
