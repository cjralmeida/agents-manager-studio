import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getStudioSettings, updateStudioSettings } from './service.js';

const settingsBody = z.object({ githubBoardTemplateUrl: z.string().trim().max(500).nullable() }).strict();

export async function studioSettingsRoutes(app: FastifyInstance) {
  app.get('/studio-settings', async () => getStudioSettings());

  app.put('/studio-settings', async (request) => updateStudioSettings(parseInput(settingsBody, request.body)));
}
