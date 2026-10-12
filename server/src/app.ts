import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { config } from './config.js';
import { prisma } from './db.js';
import { HttpError } from './lib/errors.js';
import { agentAccountRoutes } from './modules/agent-accounts/routes.js';
import { agentProfileRoutes } from './modules/agent-profiles/routes.js';
import { assistantRoutes } from './modules/assistant/routes.js';
import { installAuthGuard } from './modules/auth/guard.js';
import { authRoutes } from './modules/auth/routes.js';
import { agentRoutes, agentRunnerRoutes } from './modules/agents/routes.js';
import { boardRoutes } from './modules/boards/routes.js';
import { gitAccountRoutes } from './modules/git-accounts/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { renderRoutes } from './modules/render/routes.js';
import { skillRoutes } from './modules/skills/routes.js';
import { studioSettingsRoutes } from './modules/studio-settings/routes.js';
import { systemRoutes } from './modules/system/routes.js';
import { usageRoutes } from './modules/usage/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { workflowRoutes } from './modules/workflows/routes.js';
import { previewRoutes } from './modules/previews/routes.js';
import { capacityRoutes } from './modules/capacity/routes.js';
import { roadmapRoutes } from './modules/roadmaps/routes.js';
import { workspaceSettingsRoutes } from './modules/workspace-settings/routes.js';
import { agentVariableRoutes } from './modules/agent-variables/routes.js';
import { viewProfileRoutes } from './modules/view-profiles/routes.js';
import { clickupRoutes } from './modules/clickup/routes.js';
import { pixellabRoutes } from './modules/pixellab/routes.js';
import { autoAnswerRoutes } from './modules/auto-answer/routes.js';
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
      installAuthGuard(api);
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(systemRoutes);
      await api.register(usageRoutes);
      await api.register(workspaceRoutes);
      await api.register(workspaceSettingsRoutes);
      await api.register(agentVariableRoutes);
      await api.register(viewProfileRoutes);
      await api.register(clickupRoutes);
      await api.register(pixellabRoutes);
      await api.register(autoAnswerRoutes);
      await api.register(gitAccountRoutes);
      await api.register(agentAccountRoutes);
      await api.register(skillRoutes);
      await api.register(studioSettingsRoutes);
      await api.register(boardRoutes);
      await api.register(renderRoutes);
      await api.register(workflowRoutes);
      await api.register(previewRoutes);
      await api.register(capacityRoutes);
      await api.register(roadmapRoutes);
      await api.register(assistantRoutes);
      await api.register(agentProfileRoutes);
      await api.register(agentRoutes);
      await api.register(agentRunnerRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
