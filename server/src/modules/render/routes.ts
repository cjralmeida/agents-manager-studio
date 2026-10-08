import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import {
  connectRender,
  disconnectRender,
  getDeployment,
  getRenderSettings,
  listAvailableServices,
  listDeployments,
  setProjectService,
  startDeploy,
} from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const environment = z.enum(['HOMOLOGACAO', 'PRODUCAO']);

const connectBody = z.object({ apiKey: z.string().trim().min(10).max(500) }).strict();
const serviceBody = z.object({ projectId: z.uuid(), environment, serviceId: z.string().min(1).max(100).nullable() }).strict();
const deployBody = z.object({ projectId: z.uuid(), environment: environment.default('HOMOLOGACAO') }).strict();

export async function renderRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/render', async (request) => getRenderSettings(parseInput(workspaceParams, request.params).id));

  app.put('/workspaces/:id/render', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return connectRender(id, parseInput(connectBody, request.body).apiKey);
  });

  app.delete('/workspaces/:id/render', async (request, reply) => {
    await disconnectRender(parseInput(workspaceParams, request.params).id);
    return reply.code(204).send();
  });

  app.get('/workspaces/:id/render/available-services', async (request) =>
    listAvailableServices(parseInput(workspaceParams, request.params).id),
  );

  app.put('/workspaces/:id/render/services', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return setProjectService(id, parseInput(serviceBody, request.body));
  });

  app.get('/workspaces/:id/deployments', async (request) => listDeployments(parseInput(workspaceParams, request.params).id));

  /** Manual deploy of the project's current branch on Render (no merge). */
  app.post('/workspaces/:id/deployments', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await startDeploy({ workspaceId: id, ...parseInput(deployBody, request.body) }));
  });

  app.get('/deployments/:id', async (request) => getDeployment(parseInput(z.object({ id: z.uuid() }), request.params).id));
}
