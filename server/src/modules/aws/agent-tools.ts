import { prisma } from '../../db.js';
import type { Agent, AwsService } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { addEvent } from '../agents/service.js';
import { parseEnvVars } from '../render/env-vars.js';
import { type AmplifyConfig, type Ec2Config, awsClientFor, awsEnvVarKeys, setAwsEnvVars } from './service.js';

/**
 * The render_* agent tools for a project that runs on AWS: same names and answers, so the skills and workflows do
 * not change (render_deploy and render_deploy_status go through the shared deploy flow).
 */

type Args = Record<string, unknown>;

const LOG_TAIL = 12_000;

export async function awsServiceView(agent: Agent, service: AwsService) {
  const keys = await awsEnvVarKeys(agent.workspaceId, service).catch((error: Error) => [`(não foi possível ler: ${error.message})`]);
  const deploys = await prisma.deployment.findMany({ where: { projectId: service.projectId, environment: service.environment }, orderBy: { startedAt: 'desc' }, take: 5 });
  const config = service.config as Record<string, unknown>;
  return {
    environment: service.environment === 'HOMOLOGACAO' ? 'homologação' : 'produção',
    provider: service.kind === 'amplify' ? 'AWS Amplify' : 'AWS EC2 (Docker)',
    prBaseBranch: agent.baseBranch,
    service: {
      name: service.name,
      url: service.url,
      branch: service.branch,
      ...(service.kind === 'ec2'
        ? {
            build: 'imagem gerada pelo Studio a partir do Dockerfile do repositório (raiz, ou o caminho configurado), no commit do merge',
            dockerfile: config.dockerfile ?? 'Dockerfile',
            port: config.port,
            healthCheckPath: config.healthPath,
            variables: `Parameter Store em ${config.parameterPath} (vira o .env do container a cada deploy); PORT=${config.port} é passado sempre`,
          }
        : { build: 'o Amplify gera o site pelo amplify.yml / configuração do app, a partir da branch', variables: 'variáveis de ambiente da branch no Amplify (valem no build)' }),
    },
    envVarKeys: keys,
    recentDeploys: deploys.map((deploy) => ({ id: deploy.id, status: deploy.status, commitId: deploy.commitId, startedAt: deploy.startedAt, error: deploy.error })),
  };
}

export async function setAwsVarsTool(agent: Agent, service: AwsService, args: Args) {
  const vars = parseEnvVars(args.vars);
  const existing = new Set(await awsEnvVarKeys(agent.workspaceId, service));
  await setAwsEnvVars(agent.workspaceId, service, vars);
  const created = vars.filter((entry) => !existing.has(entry.key)).map((entry) => entry.key);
  const updated = vars.filter((entry) => existing.has(entry.key)).map((entry) => entry.key);
  await addEvent(agent.id, 'status', {
    message: `Variáveis da AWS (${service.name}) — ${[created.length && `criadas: ${created.join(', ')}`, updated.length && `alteradas: ${updated.join(', ')}`].filter(Boolean).join('; ')}.`,
  });
  return { created, updated, message: 'Variáveis gravadas. Elas valem a partir do próximo deploy (render_deploy).' };
}

export async function awsLogs(agent: Agent, service: AwsService, args: Args) {
  const type = args.type === 'app' || args.type === 'request' ? args.type : 'build';
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 300);
  const text = typeof args.text === 'string' && args.text.trim() ? args.text.trim() : undefined;
  const { client } = await awsClientFor(agent.workspaceId);
  if (type === 'build') {
    const last = await prisma.deployment.findFirst({ where: { projectId: service.projectId, environment: service.environment }, orderBy: { startedAt: 'desc' } });
    if (!last) return { type, lines: [], note: 'Nenhum deploy ainda.' };
    let log = last.log ?? '';
    if (service.kind === 'amplify' && last.renderDeployId?.startsWith('amplify:')) {
      const config = service.config as unknown as AmplifyConfig;
      const job = await client.amplifyJob(config.appId, config.branchName, last.renderDeployId.slice('amplify:'.length));
      for (const step of job.steps.filter((entry) => entry.logUrl)) {
        const body = await fetch(step.logUrl!, { signal: AbortSignal.timeout(20_000) }).then((response) => response.text()).catch(() => '');
        log += `\n--- ${step.name} (${step.status})\n${body.slice(-LOG_TAIL)}`;
      }
    }
    const lines = log.split('\n').filter((line) => !text || line.includes(text)).slice(-limit);
    return { type, deploymentId: last.id, status: last.status, lines };
  }
  if (service.kind === 'amplify') return { type, lines: [], note: 'Site estático no Amplify: não há logs de aplicação; veja type "build".' };
  const config = service.config as unknown as Ec2Config;
  const lines = await client.logLines(config.logGroup, { limit, text, minutes: Math.min(Math.max(Number(args.minutes) || 60, 5), 24 * 60) });
  return { type: 'app', lines, ...(type === 'request' && { note: 'Na AWS os logs de requisição estão junto com os da aplicação (CloudWatch).' }) };
}

export async function awsMetrics(agent: Agent, service: AwsService, args: Args) {
  if (service.kind === 'amplify') return { service: service.name, note: 'Site estático no Amplify: sem métricas de memória/CPU.' };
  const minutes = Math.min(Math.max(Number(args.minutes) || 60, 5), 24 * 60);
  const config = service.config as unknown as Ec2Config;
  const { client } = await awsClientFor(agent.workspaceId);
  const [cpu, memory] = await Promise.all([
    client.metric({ namespace: 'AWS/EC2', name: 'CPUUtilization', instanceId: config.instanceId, minutes }).catch(() => []),
    client.metric({ namespace: 'CWAgent', name: 'mem_used_percent', instanceId: config.instanceId, minutes }).catch(() => []),
  ]);
  return {
    service: service.name,
    instanceId: config.instanceId,
    window: { minutes },
    memoryUsedPercent: memory,
    memoryPeakPercent: memory.length > 0 ? Math.max(...memory.map((point) => point.value)) : null,
    cpuPercent: cpu,
    hint:
      memory.length === 0
        ? 'Sem métrica de memória: a instância precisa do agente do CloudWatch (mem_used_percent). A CPU vem do EC2.'
        : 'Memória e CPU da instância inteira (em %), não só do container.',
  };
}

export async function awsEvents(agent: Agent, service: AwsService, args: Args) {
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  const deploys = await prisma.deployment.findMany({ where: { projectId: service.projectId, environment: service.environment }, orderBy: { startedAt: 'desc' }, take: Math.min(limit, 10) });
  const events: { timestamp: string; type: string; details: unknown }[] = deploys.map((deploy) => ({
    timestamp: deploy.startedAt.toISOString(),
    type: `deploy_${deploy.status}`,
    details: { commitId: deploy.commitId, error: deploy.error },
  }));
  if (service.kind === 'ec2') {
    const config = service.config as unknown as Ec2Config;
    const { client } = await awsClientFor(agent.workspaceId);
    const instance = (await client.managedInstances().catch(() => [])).find((entry) => entry.instanceId === config.instanceId);
    events.unshift({ timestamp: new Date().toISOString(), type: instance?.online ? 'instance_online' : 'instance_offline', details: { instanceId: config.instanceId } });
    // Restarts and memory kills of the container, read on the instance.
    try {
      const commandId = await client.runScript(config.instanceId, [`docker inspect -f '{{.RestartCount}}|{{.State.Status}}|{{.State.StartedAt}}|{{.State.OOMKilled}}|{{.State.ExitCode}}' ${config.containerName}`], 'AMS events', 60);
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const result = await client.commandResult(commandId, config.instanceId);
        if (['Pending', 'InProgress', 'Delayed'].includes(result.status)) continue;
        const [restarts, status, startedAt, oomKilled, exitCode] = result.stdout.trim().split('|');
        events.unshift({
          timestamp: startedAt ?? new Date().toISOString(),
          type: oomKilled === 'true' ? 'server_failed' : status === 'running' ? 'container_running' : `container_${status ?? 'unknown'}`,
          details: { restarts: Number(restarts), oomKilled: oomKilled === 'true', exitCode: Number(exitCode), startedAt, reason: oomKilled === 'true' ? 'out of memory' : undefined },
        });
        break;
      }
    } catch {
      // Without SSM access the deploy history still answers.
    }
  }
  return {
    service: service.name,
    events: events.slice(0, limit),
    hint: 'Na AWS: "container_running" com restarts > 0 ou "server_failed" (falta de memória) indicam instabilidade; os deploys também aparecem.',
  };
}

export function requireAwsBranch(agent: Agent, service: AwsService) {
  if (service.branch && service.branch !== agent.baseBranch) {
    throw new HttpError(422, `O serviço publica a branch "${service.branch}", mas o PR/MR deste trabalho vai para "${agent.baseBranch}". Pergunte ao usuário como seguir.`);
  }
}
