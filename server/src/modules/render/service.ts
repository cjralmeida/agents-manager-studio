import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { DeployEnvironment, Deployment, RenderAccount } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { mergePullRequest } from '../agents/pull-requests.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { createRenderClient } from './api.js';
import { isFinished, isSuccess, pullRequestNumber, statusLabel } from './status.js';

// ---------------------------------------------------------------- accounts

const withUsage = { _count: { select: { workspaceSettings: true } } } as const;

function accountResponse(account: RenderAccount & { _count: { workspaceSettings: number } }) {
  return {
    id: account.id,
    label: account.label,
    ownerName: account.ownerName,
    apiKeyHint: account.apiKeyHint,
    workspaceCount: account._count.workspaceSettings,
  };
}

/** Name of the Render workspace/team behind a key; also proves the key works. */
async function ownerNameOf(apiKey: string) {
  const owners = await createRenderClient(apiKey).owners();
  return owners.map((owner) => owner.name).join(', ') || 'Render';
}

export async function listRenderAccounts(ownerId: string) {
  const accounts = await prisma.renderAccount.findMany({ where: { ownerId }, include: withUsage, orderBy: { label: 'asc' } });
  return accounts.map(accountResponse);
}

export async function createRenderAccount(ownerId: string, input: { label: string; apiKey: string }) {
  const ownerName = await ownerNameOf(input.apiKey);
  const account = await prisma.renderAccount.create({
    data: { ownerId, label: input.label, apiKeyEncrypted: secrets.encrypt(input.apiKey), apiKeyHint: secretHint(input.apiKey), ownerName },
    include: withUsage,
  });
  return accountResponse(account);
}

export async function updateRenderAccount(id: string, input: { label?: string; apiKey?: string }) {
  await findAccount(id);
  const keyData = input.apiKey
    ? { apiKeyEncrypted: secrets.encrypt(input.apiKey), apiKeyHint: secretHint(input.apiKey), ownerName: await ownerNameOf(input.apiKey) }
    : {};
  const account = await prisma.renderAccount.update({ where: { id }, data: { label: input.label, ...keyData }, include: withUsage });
  return accountResponse(account);
}

/** Checks the stored key on Render again. */
export async function verifyRenderAccount(id: string) {
  const account = await findAccount(id);
  const ownerName = await ownerNameOf(secrets.decrypt(account.apiKeyEncrypted));
  await prisma.renderAccount.update({ where: { id }, data: { ownerName } });
  return { ok: true as const, ownerName };
}

/** Workspaces using it keep their services but lose the account (ON DELETE SET NULL). */
export async function deleteRenderAccount(id: string) {
  await findAccount(id);
  await prisma.renderAccount.delete({ where: { id } });
}

async function findAccount(id: string) {
  const account = await prisma.renderAccount.findUnique({ where: { id } });
  if (!account) throw notFound('Conta do Render não encontrada.');
  return account;
}

// ---------------------------------------------------------------- workspace

async function clientFor(workspaceId: string) {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { renderAccount: true } });
  if (!settings?.renderAccount) throw new HttpError(422, 'Escolha uma conta do Render na aba Conectores do workspace.');
  return createRenderClient(secrets.decrypt(settings.renderAccount.apiKeyEncrypted));
}

export async function getRenderSettings(workspaceId: string) {
  const [settings, services] = await Promise.all([
    prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { renderAccount: true } }),
    prisma.renderService.findMany({ where: { workspaceId }, orderBy: { serviceName: 'asc' } }),
  ]);
  const account = settings?.renderAccount;
  return {
    connection: account ? { accountId: account.id, label: account.label, ownerName: account.ownerName, apiKeyHint: account.apiKeyHint } : null,
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

/** Workspaces that use a Render account, for the Connectors page. */
export async function listRenderConnections(ownerId: string) {
  const settings = await prisma.workspaceSettings.findMany({
    where: { renderAccountId: { not: null }, workspace: { ownerId } },
    include: { renderAccount: true, workspace: { select: { name: true, _count: { select: { renderServices: true } } } } },
    orderBy: { workspace: { name: 'asc' } },
  });
  return settings.map((entry) => ({
    workspaceId: entry.workspaceId,
    workspaceName: entry.workspace.name,
    accountLabel: entry.renderAccount!.label,
    ownerName: entry.renderAccount!.ownerName,
    services: entry.workspace._count.renderServices,
  }));
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
