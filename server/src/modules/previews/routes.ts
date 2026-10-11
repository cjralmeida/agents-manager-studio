import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { assertOwnsProject } from '../auth/ownership.js';
import { checkLatest, previewState, startPreview, stopPreview } from './service.js';

const params = z.object({ id: z.uuid() });

/** "Rodar": serves the project's latest stable (checked) version at http://<project>.localhost. */
export async function previewRoutes(app: FastifyInstance) {
  const projectOf = async (request: { params: unknown; user: { id: string } }) => {
    const { id } = parseInput(params, request.params);
    await assertOwnsProject(id, request.user.id);
    return id;
  };

  app.get('/projects/:id/preview', async (request) => previewState(await projectOf(request)));

  app.post('/projects/:id/preview/start', async (request) => startPreview(await projectOf(request), request.log));

  app.post('/projects/:id/preview/stop', async (request) => stopPreview(await projectOf(request)));

  /** Checks the newest commit again, even when it was already checked. */
  app.post('/projects/:id/preview/check', async (request) => {
    const id = await projectOf(request);
    await checkLatest(id, { force: true, log: request.log });
    return previewState(id);
  });
}
