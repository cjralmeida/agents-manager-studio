import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { config } from './config.js';
import { prisma } from './db.js';
import { healthRoutes } from './modules/health/routes.js';

function loggerOptions(): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(config.isDev && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  };
}

export async function buildApp() {
  const app = Fastify({ logger: loggerOptions() });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.code(500).send({ message: 'Erro interno. Tente novamente.' });
    }
    return reply.code(statusCode).send({ message: error.message });
  });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  await app.register(healthRoutes, { prefix: '/api' });

  return app;
}
