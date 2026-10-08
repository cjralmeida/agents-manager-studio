import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { DeployEnvironment, Deployment } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { mergePullRequest } from '../agents/pull-requests.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { createRenderClient } from './api.js';
import { isFinished, isSuccess, pullRequestNumber, statusLabel } from './status.js';

// ---------------------------------------------------------------- connection

async function clientFor(workspaceId: string) {
  const connection = await prisma.renderConnection.findUnique({ where: { workspaceId } });
  if (!connection) throw new HttpError(422, 'Conecte uma conta do Render nas configurações do workspace.');
  return createRenderClient(secrets.decrypt(connection.apiKeyEncrypted));
}

export async function getRenderSettings(workspaceId: string) {
  const [connection, services] = await Promise.all([
    prisma.renderConnection.findUnique({ where: { workspaceId } }),
    prisma.renderService.findMany({ where: { workspaceId }, orderBy: { serviceName: 'asc' } }),
  ]);
  return {
    connection: connection ? { ownerName: connection.ownerName, apiKeyHint: connection.apiKeyHint } : null,
    services: services.map(({ id, projectId, environment, serviceId, serviceName, branch, url, dashboardUrl }) => ({
      id,
      projectId,
      environment,
      serviceId,
      serviceName,
      branch,
      url,
      dashboardUrl,
    })),
  };
}

/** Checks the key on Render before saving it. */
export async function connectRender(workspaceId: string, apiKey: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const owners = await createRenderClient(apiKey).owners();
  const data = {
    apiKeyEncrypted: secrets.encrypt(apiKey),
    apiKeyHint: secretHint(apiKey),
    ownerName: owners.map((owner) => owner.name).join(', ') || 'Render',
  };
  await prisma.renderConnection.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  return getRenderSettings(workspaceId);
}

export async function disconnectRender(workspaceId: string) {
  await prisma.renderConnection.deleteMany({ where: { workspaceId } });
}

/** Services the key can see, to choose which one runs each project. */
export async function listAvailableServices(workspaceId: string) {
  return (await clientFor(workspaceId)).services();
}

/** Sets (or clears, with a null serviceId) the Render service of a project in an environment. */
export async function setProjectService(workspaceId: string, input: { projectId: string; environment: DeployEnvironment; serviceId: string | null }) {
  const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId } });
  if (!project) throw notFound('Projeto não encontrado neste workspace.');

  if (!input.serviceId) {
    await prisma.renderService.deleteMany({ where: { projectId: input.projectId, environment: input.environment } });
    return getRenderSettings(workspaceId);
  }
  const service = (await listAvailableServices(workspaceId)).find((entry) => entry.id === input.serviceId);
  if (!service) throw notFound('Serviço não encontrado no Render.');
  const data = {
    workspaceId,
    serviceId: service.id,
    serviceName: service.name,
    branch: service.branch,
    url: service.url,
    dashboardUrl: service.dashboardUrl,
  };
  await prisma.renderService.upsert({
    where: { projectId_environment: { projectId: input.projectId, environment: input.environment } },
    create: { projectId: input.projectId, environment: input.environment, ...data },
    update: data,
  });
  return getRenderSettings(workspaceId);
}

// ---------------------------------------------------------------- deployments

export interface StartDeployInput {
  workspaceId: string;
  projectId: string;
  environment?: DeployEnvironment;
  /** Agent whose PR/MR is merged before deploying (workflows). */
  agentId?: string;
}

function toResponse(deployment: Deployment) {
  return {
    ...deployment,
    statusLabel: statusLabel(deployment.status),
    isFinished: isFinished(deployment.status),
    isSuccess: isSuccess(deployment.status),
  };
}

/**
 * Starts a deploy: merges the agent's PR/MR (when given) into the branch the service deploys from, then
 * asks Render to deploy. Progress is followed by the deployment monitor.
 */
export async function startDeploy(input: StartDeployInput) {
  const environment = input.environment ?? 'HOMOLOGACAO';
  const service = await prisma.renderService.findUnique({ where: { projectId_environment: { projectId: input.projectId, environment } } });
  if (!service) {
    const label = environment === 'HOMOLOGACAO' ? 'homologação' : 'produção';
    throw new HttpError(422, `O projeto não tem serviço do Render de ${label} configurado.`);
  }
  await clientFor(input.workspaceId);

  const agent = input.agentId ? await prisma.agent.findUnique({ where: { id: input.agentId } }) : null;
  const deployment = await prisma.deployment.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      environment,
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      status: agent?.prUrl ? 'merging' : 'starting',
      prUrl: agent?.prUrl ?? null,
      agentId: agent?.id ?? null,
    },
  });
  void runDeploy(deployment.id);
  return toResponse(deployment);
}

async function fail(id: string, error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
  await prisma.deployment.update({ where: { id }, data: { status: 'error', error: message, finishedAt: new Date() } });
}

async function runDeploy(id: string) {
  try {
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    let commitId: string | null = null;

    if (deployment.prUrl && deployment.projectId) {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: deployment.projectId } });
      const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
      const number = pullRequestNumber(deployment.prUrl);
      if (!remote || !number) throw new HttpError(422, 'Não foi possível identificar o PR/MR para o merge.');
      const account = await findWorkspaceGitAccount(deployment.workspaceId, [remoteHostname(remote), remote.host]);
      commitId = await mergePullRequest({
        provider: account.provider as 'GITHUB' | 'GITLAB',
        remote,
        token: secrets.decrypt(account.tokenEncrypted),
        number,
      });
    }

    const render = await clientFor(deployment.workspaceId);
    const deploy = await render.deploy(deployment.serviceId, commitId ?? undefined);
    await prisma.deployment.update({
      where: { id },
      data: { renderDeployId: deploy.id, status: deploy.status, commitId: deploy.commitId ?? commitId },
    });
  } catch (error) {
    await fail(id, error);
  }
}

export async function listDeployments(workspaceId: string) {
  const deployments = await prisma.deployment.findMany({ where: { workspaceId }, orderBy: { startedAt: 'desc' }, take: 30 });
  return deployments.map(toResponse);
}

export async function getDeployment(id: string) {
  const deployment = await prisma.deployment.findUnique({ where: { id } });
  if (!deployment) throw notFound('Deploy não encontrado.');
  return toResponse(deployment);
}

// ---------------------------------------------------------------- monitor

const MONITOR_MS = 15_000;
/** Deploys that never reach Render (e.g. the server stopped mid-merge) are given up after this long. */
const STALE_MS = 60 * 60_000;

async function pollDeployments(log: FastifyBaseLogger) {
  const pending = await prisma.deployment.findMany({ where: { finishedAt: null } });
  for (const deployment of pending) {
    try {
      if (!deployment.renderDeployId) {
        if (Date.now() - deployment.startedAt.getTime() > STALE_MS) await fail(deployment.id, new Error('O deploy não chegou a ser enviado ao Render.'));
        continue;
      }
      const render = await clientFor(deployment.workspaceId);
      const deploy = await render.getDeploy(deployment.serviceId, deployment.renderDeployId);
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: deploy.status,
          commitId: deploy.commitId ?? deployment.commitId,
          ...(isFinished(deploy.status) && { finishedAt: new Date() }),
        },
      });
    } catch (err) {
      log.warn({ deploymentId: deployment.id, err }, 'Deployment poll failed');
    }
  }
}

/** Follows deploys until they finish; started with the server, so it resumes after a restart. */
export function startDeploymentMonitor(log: FastifyBaseLogger) {
  const timer = setInterval(() => void pollDeployments(log).catch((err: unknown) => log.error({ err }, 'Deployment monitor failed')), MONITOR_MS);
  return () => clearInterval(timer);
}
