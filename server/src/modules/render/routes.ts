import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import {
  createRenderAccount,
  deleteRenderAccount,
  getDeployment,
  getRenderSettings,
  listAvailableServices,
  listDeployments,
  listRenderAccounts,
  listRenderConnections,
  setProjectService,
  startDeploy,
  updateRenderAccount,
  verifyRenderAccount,
} from './service.js';

const idParams = z.object({ id: z.uuid() });
const environment = z.enum(['HOMOLOGACAO', 'PRODUCAO']);

/** Spaces and line breaks pasted with the key are never part of it. */
const apiKey = z.string().transform((value) => value.replace(/\s+/g, '')).pipe(z.string().min(10).max(500));
const accountBody = z.object({ label: z.string().trim().min(1).max(80), apiKey }).strict();
const accountUpdateBody = z.object({ label: z.string().trim().min(1).max(80).optional(), apiKey: apiKey.optional() }).strict();

const serviceBody = z.object({ projectId: z.uuid(), environment, serviceId: z.string().min(1).max(100).nullable() }).strict();
const deployBody = z.object({ projectId: z.uuid(), environment: environment.default('HOMOLOGACAO') }).strict();

export async function renderRoutes(app: FastifyInstance) {
  // Global Render accounts (Conectores page); workspaces pick one in their settings.
  app.get('/render-accounts', async (request) => listRenderAccounts(request.user.id));

  app.post('/render-accounts', async (request, reply) =>
    reply.code(201).send(await createRenderAccount(request.user.id, parseInput(accountBody, request.body))),
  );

  app.patch('/render-accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateRenderAccount(id, parseInput(accountUpdateBody, request.body));
  });

  app.post('/render-accounts/:id/verify', async (request) => verifyRenderAccount(parseInput(idParams, request.params).id));

  app.delete('/render-accounts/:id', async (request, reply) => {
    await deleteRenderAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });

  app.get('/render/connections', async (request) => listRenderConnections(request.user.id));

  // Per workspace: the chosen account and which service runs each project.
  app.get('/workspaces/:id/render', async (request) => getRenderSettings(parseInput(idParams, request.params).id));

  app.get('/workspaces/:id/render/available-services', async (request) => listAvailableServices(parseInput(idParams, request.params).id));

  app.put('/workspaces/:id/render/services', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return setProjectService(id, parseInput(serviceBody, request.body));
  });

  app.get('/workspaces/:id/deployments', async (request) => listDeployments(parseInput(idParams, request.params).id));

  /** Manual deploy of the project's current branch on Render (no merge). */
  app.post('/workspaces/:id/deployments', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    return reply.code(201).send(await startDeploy({ workspaceId: id, ...parseInput(deployBody, request.body) }));
  });

  app.get('/deployments/:id', async (request) => getDeployment(parseInput(idParams, request.params).id));
}
