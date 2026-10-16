import { prisma } from '../../db.js';
import type { Agent } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { addEvent, publishAgentWork } from '../agents/service.js';
import { createRenderClient } from './api.js';
import { parseEnvVars } from './env-vars.js';
import { getDeployment, startDeploy } from './service.js';
import { awsEvents, awsLogs, awsMetrics, awsServiceView, requireAwsBranch, setAwsVarsTool } from '../aws/agent-tools.js';
import { awsServiceOf } from '../aws/service.js';

/**
 * Render tools for agents. The "render" group touches only the homologation service of the agent's project; the
 * "render_read" group (testers) only reads: homologation URLs of every project and their logs. The API key stays on
 * the server; variable values are written but never read back.
 */
export const RENDER_TOOL_NAMES = [
  'render_service',
  'render_set_env_vars',
  'render_deploy',
  'render_deploy_status',
  'render_logs',
  'render_environments',
  'render_metrics',
  'render_events',
] as const;
/** Tools of the read-only group. */
export const RENDER_READ_TOOLS: readonly string[] = ['render_logs', 'render_environments', 'render_metrics', 'render_events'];
export type RenderToolName = (typeof RENDER_TOOL_NAMES)[number];

type Args = Record<string, unknown>;

const ENVIRONMENT = 'HOMOLOGACAO' as const;
const MAX_WAIT_SECONDS = 240;
const POLL_MS = 10_000;

/** Project named by the agent (read tools), or the agent's own project. */
async function projectIdFor(agent: Agent, projectName: unknown) {
  if (typeof projectName === 'string' && projectName.trim()) {
    const projects = await prisma.project.findMany({ where: { workspaceId: agent.workspaceId, missingAt: null }, select: { id: true, name: true } });
    const project = projects.find((entry) => entry.name.toLowerCase() === projectName.trim().toLowerCase());
    if (!project) throw new HttpError(404, `Projeto "${projectName}" não encontrado. Projetos: ${projects.map((entry) => entry.name).join(', ')}.`);
    return project.id;
  }
  if (!agent.projectId) throw new HttpError(422, 'Informe o projeto (veja render_environments).');
  return agent.projectId;
}

async function homologation(agent: Agent, projectName?: unknown) {
  const projectId = await projectIdFor(agent, projectName);
  const [service, settings] = await Promise.all([
    prisma.renderService.findUnique({ where: { projectId_environment: { projectId, environment: ENVIRONMENT } } }),
    prisma.workspaceSettings.findUnique({ where: { workspaceId: agent.workspaceId }, include: { renderAccount: true } }),
  ]);
  if (!settings?.renderAccount) throw new HttpError(422, 'O workspace não tem conta do Render. Pergunte ao usuário (AskUserQuestion) e pare.');
  if (!service) {
    throw new HttpError(
      422,
      'O projeto não tem serviço do Render de homologação configurado no Studio (aba Conectores do workspace). Pergunte ao usuário e pare.',
    );
  }
  return { service, client: createRenderClient(secrets.decrypt(settings.renderAccount.apiKeyEncrypted)) };
}

/** The service must deploy from the branch the agent's PR/MR merges into, or the deploy would not carry the work. */
function checkBranch(agent: Agent, branch: string | null) {
  if (branch && branch !== agent.baseBranch) {
    throw new HttpError(
      422,
      `O serviço de homologação publica a branch "${branch}", mas o PR/MR deste trabalho vai para "${agent.baseBranch}". Pergunte ao usuário como seguir.`,
    );
  }
}

async function ownDeployment(agent: Agent, id: unknown) {
  const deployment = typeof id === 'string' ? await getDeployment(id).catch(() => null) : null;
  if (!deployment || deployment.workspaceId !== agent.workspaceId || deployment.projectId !== agent.projectId) {
    throw new HttpError(404, 'Deploy não encontrado para este projeto. Use o deploymentId que render_deploy devolveu.');
  }
  return deployment;
}

function deploymentView(deployment: Awaited<ReturnType<typeof getDeployment>>) {
  return {
    deploymentId: deployment.id,
    status: deployment.status,
    statusLabel: deployment.statusLabel,
    finished: deployment.isFinished,
    success: deployment.isSuccess,
    commitId: deployment.commitId,
    prUrl: deployment.prUrl,
    error: deployment.error,
    ...(deployment.isFinished && !deployment.isSuccess && { hint: 'Leia os logs com render_logs (type "build", ou "app" se a aplicação não subiu).' }),
  };
}

export async function runRenderTool(agent: Agent, name: RenderToolName, args: Args) {
  if (name === 'render_environments') {
    const [services, awsServices] = await Promise.all([
      prisma.renderService.findMany({
        where: { workspaceId: agent.workspaceId, environment: ENVIRONMENT },
        include: { project: { select: { name: true } } },
        orderBy: { serviceName: 'asc' },
      }),
      prisma.awsService.findMany({ where: { workspaceId: agent.workspaceId, environment: ENVIRONMENT } }),
    ]);
    const projects = await prisma.project.findMany({ where: { id: { in: awsServices.map((service) => service.projectId) } }, select: { id: true, name: true } });
    const onAws = new Set(awsServices.map((service) => service.projectId));
    return {
      environment: 'homologação',
      services: [
        ...services.filter((service) => !onAws.has(service.projectId)).map((service) => ({ project: service.project.name, service: service.serviceName, url: service.url, branch: service.branch, provider: 'Render' })),
        ...awsServices.map((service) => ({
          project: projects.find((project) => project.id === service.projectId)?.name ?? '?',
          service: service.name,
          url: service.url,
          branch: service.branch,
          provider: service.kind === 'amplify' ? 'AWS Amplify' : 'AWS EC2',
        })),
      ],
    };
  }

  const readsAnyProject = name === 'render_logs' || name === 'render_metrics' || name === 'render_events';
  // Projects that run on AWS answer the same tools from the AWS connector.
  const aws = await awsServiceOf(await projectIdFor(agent, readsAnyProject ? args.project : undefined), ENVIRONMENT);
  if (aws) {
    switch (name) {
      case 'render_service':
        return awsServiceView(agent, aws);
      case 'render_set_env_vars':
        return setAwsVarsTool(agent, aws, args);
      case 'render_logs':
        return awsLogs(agent, aws, args);
      case 'render_metrics':
        return awsMetrics(agent, aws, args);
      case 'render_events':
        return awsEvents(agent, aws, args);
      case 'render_deploy': {
        requireAwsBranch(agent, aws);
        const published = await publishAgentWork(agent.id);
        const deployment = await startDeploy({ workspaceId: agent.workspaceId, projectId: agent.projectId!, environment: ENVIRONMENT, ...(published.toMerge && { agentId: agent.id }) });
        await addEvent(agent.id, 'status', { message: `Deploy em homologação iniciado na AWS (${aws.name}).` });
        return {
          ...deploymentView(deployment),
          merged: published.toMerge ? 'o Studio faz o merge do PR/MR antes do deploy' : 'nada novo para mesclar: a branch base já tem tudo',
          serviceUrl: aws.url,
          next: 'Acompanhe com render_deploy_status até finished = true (na AWS o Studio gera a imagem, publica e espera o health check).',
        };
      }
      case 'render_deploy_status': {
        const wait = Math.min(Math.max(Number(args.waitSeconds ?? 180) || 0, 0), MAX_WAIT_SECONDS);
        const deadline = Date.now() + wait * 1000;
        let deployment = await ownDeployment(agent, args.deploymentId);
        while (!deployment.isFinished && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          deployment = await ownDeployment(agent, args.deploymentId);
        }
        return { ...deploymentView(deployment), serviceUrl: aws.url };
      }
    }
  }
  const { service, client } = await homologation(agent, readsAnyProject ? args.project : undefined);

  switch (name) {
    case 'render_service': {
      const [details, envVarKeys, deploys] = await Promise.all([
        client.serviceDetails(service.serviceId),
        client.envVarKeys(service.serviceId),
        prisma.deployment.findMany({
          where: { projectId: agent.projectId, environment: ENVIRONMENT },
          orderBy: { startedAt: 'desc' },
          take: 5,
        }),
      ]);
      const { ownerId: _ownerId, ...visible } = details;
      return {
        environment: 'homologação',
        prBaseBranch: agent.baseBranch,
        service: visible,
        envVarKeys,
        recentDeploys: deploys.map((deploy) => ({ id: deploy.id, status: deploy.status, commitId: deploy.commitId, startedAt: deploy.startedAt, error: deploy.error })),
      };
    }

    case 'render_set_env_vars': {
      const vars = parseEnvVars(args.vars);
      const existing = new Set(await client.envVarKeys(service.serviceId));
      for (const entry of vars) {
        await client.setEnvVar(service.serviceId, entry.key, entry.generate ? { generateValue: true } : { value: entry.value! });
      }
      const created = vars.filter((entry) => !existing.has(entry.key)).map((entry) => entry.key);
      const updated = vars.filter((entry) => existing.has(entry.key)).map((entry) => entry.key);
      await addEvent(agent.id, 'status', {
        message: `Variáveis do Render (homologação) — ${[created.length && `criadas: ${created.join(', ')}`, updated.length && `alteradas: ${updated.join(', ')}`].filter(Boolean).join('; ')}.`,
      });
      return { created, updated, message: 'Variáveis gravadas. Elas valem a partir do próximo deploy (render_deploy).' };
    }

    case 'render_deploy': {
      checkBranch(agent, (await client.serviceDetails(service.serviceId)).branch);
      const published = await publishAgentWork(agent.id);
      const deployment = await startDeploy({
        workspaceId: agent.workspaceId,
        projectId: agent.projectId!,
        environment: ENVIRONMENT,
        ...(published.toMerge && { agentId: agent.id }),
      });
      await addEvent(agent.id, 'status', { message: `Deploy em homologação iniciado (${service.serviceName}).` });
      return {
        ...deploymentView(deployment),
        merged: published.toMerge ? 'o Studio faz o merge do PR/MR antes do deploy' : 'nada novo para mesclar: a branch base já tem tudo',
        serviceUrl: service.url,
        next: 'Acompanhe com render_deploy_status até finished = true.',
      };
    }

    case 'render_deploy_status': {
      const wait = Math.min(Math.max(Number(args.waitSeconds ?? 180) || 0, 0), MAX_WAIT_SECONDS);
      const deadline = Date.now() + wait * 1000;
      let deployment = await ownDeployment(agent, args.deploymentId);
      while (!deployment.isFinished && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        deployment = await ownDeployment(agent, args.deploymentId);
      }
      return { ...deploymentView(deployment), serviceUrl: service.url };
    }

    case 'render_logs': {
      const type = args.type === 'app' || args.type === 'request' ? args.type : 'build';
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 300);
      const details = await client.serviceDetails(service.serviceId);
      const lines = await client.logs({
        ownerId: details.ownerId,
        serviceId: service.serviceId,
        type,
        limit,
        text: typeof args.text === 'string' && args.text.trim() ? args.text.trim() : undefined,
      });
      return { type, lines };
    }

    case 'render_metrics': {
      // Up to 24 h back; about 60 points whatever the window, so the answer stays small.
      const minutes = Math.min(Math.max(Number(args.minutes) || 60, 5), 24 * 60);
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60_000);
      const resolutionSeconds = Math.max(60, Math.round((minutes * 60) / 60));
      const window = { serviceId: service.serviceId, startTime: start.toISOString(), endTime: end.toISOString(), resolutionSeconds };
      const [memory, limit, cpu] = await Promise.all([
        client.metric({ ...window, metric: 'memory' }),
        client.metric({ ...window, metric: 'memory-limit' }).catch(() => []),
        client.metric({ ...window, metric: 'cpu' }).catch(() => []),
      ]);
      const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
      const memoryPoints = memory.flatMap((series) => series.values);
      const limitMb = limit.flatMap((series) => series.values).map((point) => mb(point.value)).find((value) => value > 0) ?? null;
      const peak = memoryPoints.reduce((max, point) => Math.max(max, point.value), 0);
      return {
        service: service.serviceName,
        window: { from: window.startTime, to: window.endTime, minutes },
        memoryLimitMb: limitMb,
        memoryPeakMb: memoryPoints.length > 0 ? mb(peak) : null,
        memoryLastMb: memoryPoints.length > 0 ? mb(memoryPoints[memoryPoints.length - 1]!.value) : null,
        memoryMb: memoryPoints.map((point) => ({ at: point.timestamp, mb: mb(point.value) })),
        cpu: cpu.flatMap((series) => series.values).map((point) => ({ at: point.timestamp, cores: Math.round(point.value * 1000) / 1000 })),
        hint: 'A memória é a do contêiner (RSS), não só o heap da JVM. Compare o pico com o limite: perto do limite, o Render mata a instância por falta de memória (veja render_events).',
      };
    }

    case 'render_events': {
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const minutes = Number(args.minutes) || 0;
      const startTime = minutes > 0 ? new Date(Date.now() - Math.min(minutes, 7 * 24 * 60) * 60_000).toISOString() : undefined;
      const events = await client.events(service.serviceId, { limit, startTime });
      return {
        service: service.serviceName,
        events,
        hint: 'Instância que caiu aparece como "server_failed" (o motivo diz se foi falta de memória); reinícios e deploys também aparecem. Para "ficou X minutos sem reiniciar", confira que não há falha nem reinício na janela.',
      };
    }
  }
}
