import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { config } from './config.js';
import { prisma } from './db.js';
import { HttpError } from './lib/errors.js';
import { healthRoutes } from './modules/health/routes.js';
import { workspaceRoutes } from './modules/workspaces/routes.js';

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
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ message: error.message, details: error.details });
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.code(500).send({ message: 'Erro interno. Tente novamente.' });
    }
    return reply.code(statusCode).send({ message: error.message });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ message: 'Rota não encontrada.' }));

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(workspaceRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
