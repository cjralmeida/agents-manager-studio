import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { assertOwnsProject } from '../auth/ownership.js';
import { checkLatest, listProjectVariables, previewState, removeProjectVariable, saveProjectVariable, startPreview, stopPreview } from './service.js';

const params = z.object({ id: z.uuid() });
const variableParams = z.object({ id: z.uuid(), key: z.string().min(1).max(128) });
const variableBody = z.object({ value: z.string().max(20_000) }).strict();

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

  /** Variables the project receives in "Rodar" (build, tests and the running app); values never come back. */
  app.get('/projects/:id/preview/variables', async (request) => listProjectVariables(await projectOf(request)));

  app.put('/projects/:id/preview/variables/:key', async (request) => {
    const id = await projectOf(request);
    const { key } = parseInput(variableParams, request.params);
    return saveProjectVariable(id, key, parseInput(variableBody, request.body).value, request.log);
  });

  app.delete('/projects/:id/preview/variables/:key', async (request) => {
    const id = await projectOf(request);
    return removeProjectVariable(id, parseInput(variableParams, request.params).key, request.log);
  });
}
