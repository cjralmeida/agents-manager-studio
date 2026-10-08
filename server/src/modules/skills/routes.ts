import type { FastifyInstance } from 'fastify';
import { listSkills } from './service.js';

export async function skillRoutes(app: FastifyInstance) {
  app.get('/skills', async () => listSkills());
}
