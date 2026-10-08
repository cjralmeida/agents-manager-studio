import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';

type ComponentStatus = 'up' | 'down';

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'up';
  } catch {
    return 'down';
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    const database = await checkDatabase();
    const healthy = database === 'up';

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      components: { database },
    });
  });
}
