import type { FastifyInstance } from 'fastify';
import { getDiskUsage, getResourceUsage } from './service.js';

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/resources', async () => getResourceUsage());

  app.get('/system/disk', async () => getDiskUsage());
}
