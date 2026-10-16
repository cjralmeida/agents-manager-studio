import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { AwsAccount, AwsService, DeployEnvironment, Deployment, Prisma } from '../../generated/prisma/client.js';
import { secretHint } from '../../lib/crypto.js';
import { runOnce } from '../../lib/docker.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { authenticatedPushUrl, parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { mergeDeploymentPullRequest } from '../render/merge.js';
import { type AwsClient, createAwsClient } from './client.js';

/**
 * AWS connector: a project runs on an EC2 instance (backend: the Studio builds the image from the repository's
 * Dockerfile, pushes it to ECR and the instance pulls and runs it through SSM) or on an Amplify app branch (frontend:
 * Amplify builds from the repository). It takes the place of a Render service, with the same agent tools.
 */

export const AWS_SERVICE_PREFIX = 'aws:';
const CLI_IMAGE = 'docker:28-cli';
const BUILD_TIMEOUT_MS = 30 * 60_000;
const HEALTH_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 10_000;
const LOG_MAX = 60_000;

export interface Ec2Config {
  instanceId: string;
  ecrRepository: string;
  containerName: string;
  port: number;
  healthPath: string;
  logGroup: string;
  parameterPath: string;
  dockerfile?: string;
}

export interface AmplifyConfig {
  appId: string;
  branchName: string;
}

// ---------------------------------------------------------------- accounts

const withUsage = { _count: { select: { workspaceSettings: true } } } as const;

function accountResponse(account: AwsAccount & { _count: { workspaceSettings: number } }) {
  return {
    id: account.id,
    label: account.label,
    region: account.region,
    accessKeyId: account.accessKeyId,
    secretHint: account.secretHint,
    awsAccountNumber: account.awsAccountNumber,
    identityArn: account.identityArn,
    workspaceCount: account._count.workspaceSettings,
  };
}

const credentialsOf = (account: AwsAccount) => ({ accessKeyId: account.accessKeyId, secretAccessKey: secrets.decrypt(account.secretAccessKeyEnc), region: account.region });

export async function listAwsAccounts(ownerId: string) {
  const accounts = await prisma.awsAccount.findMany({ where: { ownerId }, include: withUsage, orderBy: { label: 'asc' } });
  return accounts.map(accountResponse);
}

export async function createAwsAccount(ownerId: string, input: { label: string; region: string; accessKeyId: string; secretAccessKey: string }) {
  const identity = await createAwsClient(input).identity();
  const account = await prisma.awsAccount.create({
    data: {
      ownerId,
      label: input.label,
      region: input.region,
      accessKeyId: input.accessKeyId,
      secretAccessKeyEnc: secrets.encrypt(input.secretAccessKey),
      secretHint: secretHint(input.secretAccessKey),
      awsAccountNumber: identity.account,
      identityArn: identity.arn,
    },
    include: withUsage,
  });
  return accountResponse(account);
}

export async function updateAwsAccount(id: string, input: { label?: string; region?: string; accessKeyId?: string; secretAccessKey?: string }) {
  const current = await findAccount(id);
  const next = {
    region: input.region ?? current.region,
    accessKeyId: input.accessKeyId ?? current.accessKeyId,
    secretAccessKey: input.secretAccessKey ?? secrets.decrypt(current.secretAccessKeyEnc),
  };
  const changed = input.region || input.accessKeyId || input.secretAccessKey;
  const identity = changed ? await createAwsClient(next).identity() : null;
  const account = await prisma.awsAccount.update({
    where: { id },
    data: {
      label: input.label,
      region: next.region,
      accessKeyId: next.accessKeyId,
      ...(input.secretAccessKey && { secretAccessKeyEnc: secrets.encrypt(input.secretAccessKey), secretHint: secretHint(input.secretAccessKey) }),
      ...(identity && { awsAccountNumber: identity.account, identityArn: identity.arn }),
    },
    include: withUsage,
  });
  return accountResponse(account);
}

export async function verifyAwsAccount(id: string) {
  const account = await findAccount(id);
  const identity = await createAwsClient(credentialsOf(account)).identity();
  await prisma.awsAccount.update({ where: { id }, data: { awsAccountNumber: identity.account, identityArn: identity.arn } });
  return { ok: true as const, account: identity.account, arn: identity.arn };
}

export async function deleteAwsAccount(id: string) {
  await findAccount(id);
  await prisma.awsAccount.delete({ where: { id } });
}

async function findAccount(id: string) {
  const account = await prisma.awsAccount.findUnique({ where: { id } });
  if (!account) throw notFound('Conta da AWS não encontrada.');
  return account;
}

// ---------------------------------------------------------------- workspace

export async function awsClientFor(workspaceId: string): Promise<{ client: AwsClient; account: AwsAccount }> {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { awsAccount: true } });
  if (!settings?.awsAccount) throw new HttpError(422, 'Escolha uma conta da AWS na aba Conectores do workspace.');
  return { client: createAwsClient(credentialsOf(settings.awsAccount)), account: settings.awsAccount };
}

export async function setWorkspaceAwsAccount(workspaceId: string, accountId: string | null) {
  if (accountId) await findAccount(accountId);
  await prisma.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, awsAccountId: accountId }, update: { awsAccountId: accountId } });
  return getAwsSettings(workspaceId);
}

export async function getAwsSettings(workspaceId: string) {
  const [settings, services] = await Promise.all([
    prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { awsAccount: true } }),
    prisma.awsService.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }),
  ]);
  const account = settings?.awsAccount;
  return {
    connection: account ? { accountId: account.id, label: account.label, region: account.region, awsAccountNumber: account.awsAccountNumber } : null,
    services: services.map(({ id, projectId, environment, kind, name, url, branch, config }) => ({ id, projectId, environment, kind, name, url, branch, config })),
  };
}

/** What the workspace's AWS key can see, to choose where each project runs. */
export async function listAwsTargets(workspaceId: string) {
  const { client } = await awsClientFor(workspaceId);
  const [instances, apps] = await Promise.all([client.managedInstances().catch((error: Error) => ({ error: error.message })), client.amplifyApps().catch((error: Error) => ({ error: error.message }))]);
  return { instances, amplifyApps: apps };
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

export type AwsServiceInput =
  | { projectId: string; environment: DeployEnvironment; kind: 'ec2'; url: string; branch: string; instanceId: string; port: number; healthPath?: string; dockerfile?: string }
  | { projectId: string; environment: DeployEnvironment; kind: 'amplify'; url?: string; branch: string; appId: string }
  | { projectId: string; environment: DeployEnvironment; kind: null };

/** Sets (or clears, with kind null) where a project runs on AWS in an environment. */
export async function setAwsService(workspaceId: string, input: AwsServiceInput) {
  const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId } });
  if (!project) throw notFound('Projeto não encontrado neste workspace.');
  if (input.kind === null) {
    await prisma.awsService.deleteMany({ where: { projectId: input.projectId, environment: input.environment } });
    return getAwsSettings(workspaceId);
  }
  const { client } = await awsClientFor(workspaceId);
  const env = input.environment === 'HOMOLOGACAO' ? 'hom' : 'prod';
  const base = `ams-${slug(project.name)}-${env}`;
  let name: string;
  let url: string | null;
  let config: Ec2Config | AmplifyConfig;
  if (input.kind === 'ec2') {
    const instance = (await client.managedInstances()).find((entry) => entry.instanceId === input.instanceId);
    if (!instance) throw new HttpError(422, 'Instância não encontrada no SSM desta conta/região: ela precisa do agente do SSM e do perfil de instância (veja o passo a passo).');
    name = base;
    url = input.url.replace(/\/+$/, '');
    config = {
      instanceId: input.instanceId,
      ecrRepository: base,
      containerName: base,
      port: input.port,
      healthPath: input.healthPath || '/health',
      logGroup: `/ams/${base}`,
      parameterPath: `/ams/${base}/`,
      ...(input.dockerfile && { dockerfile: input.dockerfile }),
    };
  } else {
    const branch = await client.amplifyBranch(input.appId, input.branch);
    const app = (await client.amplifyApps()).find((entry) => entry.appId === input.appId);
    name = `${app?.name ?? input.appId}/${branch.branchName}`;
    url = (input.url || `https://${branch.branchName}.${app?.domain ?? ''}`).replace(/\/+$/, '');
    config = { appId: input.appId, branchName: branch.branchName };
  }
  const data = { workspaceId, kind: input.kind, name, url, branch: input.branch, config: config as unknown as Prisma.InputJsonValue };
  await prisma.awsService.upsert({
    where: { projectId_environment: { projectId: input.projectId, environment: input.environment } },
    create: { projectId: input.projectId, environment: input.environment, ...data },
    update: data,
  });
  return getAwsSettings(workspaceId);
}

export function awsServiceOf(projectId: string, environment: DeployEnvironment) {
  return prisma.awsService.findUnique({ where: { projectId_environment: { projectId, environment } } });
}

// ---------------------------------------------------------------- deploys

/** Creates the deployment row for a project that runs on AWS and starts it in the background. */
export async function startAwsDeploy(service: AwsService, input: { workspaceId: string; projectId: string; environment: DeployEnvironment; agentId?: string }) {
  await awsClientFor(input.workspaceId);
  const agent = input.agentId ? await prisma.agent.findUnique({ where: { id: input.agentId } }) : null;
  const deployment = await prisma.deployment.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      environment: input.environment,
      serviceId: `${AWS_SERVICE_PREFIX}${service.id}`,
      serviceName: service.name,
      status: agent?.prUrl ? 'merging' : 'starting',
      prUrl: agent?.prUrl ?? null,
      agentId: agent?.id ?? null,
    },
  });
  void runAwsDeploy(deployment.id);
  return deployment;
}

const redact = (text: string, secretsToHide: string[]) => secretsToHide.filter(Boolean).reduce((out, secret) => out.replaceAll(secret, '***').replaceAll(encodeURIComponent(secret), '***'), text);

async function update(id: string, data: Prisma.DeploymentUpdateInput) {
  await prisma.deployment.update({ where: { id }, data });
}

async function appendLog(id: string, text: string) {
  const current = await prisma.deployment.findUnique({ where: { id }, select: { log: true } });
  await update(id, { log: `${current?.log ?? ''}${text}\n`.slice(-LOG_MAX) });
}

/** Runs (or runs again, after a restart) an AWS deploy to the end; every step can be repeated. */
export async function runAwsDeploy(id: string) {
  try {
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    const service = await prisma.awsService.findUnique({ where: { id: deployment.serviceId.slice(AWS_SERVICE_PREFIX.length) } });
    if (!service) throw new HttpError(422, 'O serviço da AWS deste deploy não existe mais.');
    const mergeCommit = await mergeDeploymentPullRequest(deployment);
    if (mergeCommit) await update(id, { commitId: mergeCommit });
    const commit = mergeCommit ?? deployment.commitId ?? null;
    if (service.kind === 'amplify') await deployAmplify(deployment, service, commit);
    else await deployEc2(deployment, service, commit);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    await update(id, { status: deploymentStatusOnError(await prisma.deployment.findUnique({ where: { id } })), error: message, finishedAt: new Date() });
  }
}

function deploymentStatusOnError(deployment: Deployment | null) {
  if (!deployment) return 'error';
  if (deployment.status === 'build_in_progress') return 'build_failed';
  if (deployment.status === 'update_in_progress') return 'update_failed';
  return 'error';
}

async function deployAmplify(deployment: Deployment, service: AwsService, commit: string | null) {
  const { client } = await awsClientFor(deployment.workspaceId);
  const config = service.config as unknown as AmplifyConfig;
  await update(deployment.id, { status: 'build_in_progress' });
  let jobId: string;
  try {
    jobId = await client.startAmplifyJob(config.appId, config.branchName, commit ?? undefined);
  } catch (error) {
    // The merge may have started an automatic build already: follow the newest one.
    const [latest] = await client.amplifyJobs(config.appId, config.branchName, 1);
    if (!latest || !['PENDING', 'PROVISIONING', 'RUNNING'].includes(latest.status)) throw error;
    jobId = latest.jobId;
  }
  await update(deployment.id, { renderDeployId: `amplify:${jobId}` });
  await appendLog(deployment.id, `Amplify: job ${jobId} no app ${config.appId}, branch ${config.branchName}.`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const job = await client.amplifyJob(config.appId, config.branchName, jobId);
    if (job.status === 'SUCCEED') {
      await update(deployment.id, { status: 'live', commitId: job.commitId ?? commit, finishedAt: new Date() });
      return;
    }
    if (['FAILED', 'CANCELLED'].includes(job.status)) {
      const failed = job.steps.find((step) => step.status === 'FAILED');
      await update(deployment.id, {
        status: job.status === 'CANCELLED' ? 'canceled' : 'build_failed',
        error: `Amplify: job ${jobId} ${job.status}${failed ? ` na etapa ${failed.name}` : ''}. Leia os logs com render_logs (type "build").`,
        finishedAt: new Date(),
      });
      return;
    }
  }
}

async function deployEc2(deployment: Deployment, service: AwsService, commit: string | null) {
  const { client, account } = await awsClientFor(deployment.workspaceId);
  const config = service.config as unknown as Ec2Config;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: deployment.projectId! } });
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto não tem remote para gerar a imagem.');
  const git = await findWorkspaceGitAccount(deployment.workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(git.tokenEncrypted);
  const ref = commit ?? service.branch ?? project.baseBranch ?? 'main';
  const tag = (commit ?? `${Date.now()}`).slice(0, 12);

  // 1. Image: built here from the repository (git context, at the merged commit) and pushed to ECR.
  await update(deployment.id, { status: 'build_in_progress' });
  await client.ensureRepository(config.ecrRepository);
  const login = await client.registryLogin();
  const image = `${login.registry}/${config.ecrRepository}`;
  const context = `${authenticatedPushUrl(remote, git.provider as 'GITHUB' | 'GITLAB', token)}#${ref}`;
  const dockerfile = config.dockerfile ? ` -f '${config.dockerfile.replaceAll("'", '')}'` : '';
  await appendLog(deployment.id, `Imagem ${image}:${tag} a partir de ${remote.path}#${ref}.`);
  const build = await runOnce({
    image: CLI_IMAGE,
    name: `ams-awsbuild-${deployment.id.slice(-8)}-${Date.now().toString(36)}`,
    cmd: [
      'sh',
      '-c',
      `echo "$REGISTRY_PASSWORD" | docker login --username "$REGISTRY_USER" --password-stdin "$REGISTRY" && ` +
        `docker build --platform linux/amd64${dockerfile} -t "$IMAGE:$TAG" -t "$IMAGE:latest" "$CONTEXT" && ` +
        `docker push "$IMAGE:$TAG" && docker push "$IMAGE:latest" && docker rmi "$IMAGE:$TAG" "$IMAGE:latest" >/dev/null 2>&1; echo "IMAGEM OK"`,
    ],
    env: { REGISTRY: login.registry, REGISTRY_USER: login.user, REGISTRY_PASSWORD: login.password, IMAGE: image, TAG: tag, CONTEXT: context },
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  const buildLog = redact(`${build.stdout}\n${build.stderr}`, [token, login.password]).trim();
  await appendLog(deployment.id, buildLog.slice(-40_000));
  if (build.timedOut || build.exitCode !== 0 || !build.stdout.includes('IMAGEM OK')) {
    throw new Error(build.timedOut ? 'A geração da imagem passou de 30 minutos.' : 'Falha ao gerar ou enviar a imagem (veja render_logs type "build").');
  }

  // 2. Publish: the instance pulls the image and replaces the container, with the variables from Parameter Store.
  await update(deployment.id, { status: 'update_in_progress', commitId: commit });
  const region = account.region;
  const name = config.containerName;
  const script = [
    'set -e',
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${login.registry}`,
    `docker pull ${image}:${tag}`,
    'mkdir -p /opt/ams && umask 077',
    `aws ssm get-parameters-by-path --region ${region} --path '${config.parameterPath}' --with-decryption --query 'Parameters[].[Name,Value]' --output text | while IFS="$(printf '\\t')" read -r n v; do [ -n "$n" ] && printf '%s=%s\\n' "\${n##*/}" "$v"; done > /opt/ams/${name}.env`,
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `docker run -d --name ${name} --restart unless-stopped --env-file /opt/ams/${name}.env -e PORT=${config.port} -p 127.0.0.1:${config.port}:${config.port} ` +
      `--log-driver awslogs --log-opt awslogs-region=${region} --log-opt awslogs-group=${config.logGroup} --log-opt awslogs-create-group=true ${image}:${tag}`,
    'docker image prune -af --filter "until=72h" >/dev/null 2>&1 || true',
    `echo "CONTAINER OK"`,
  ];
  const commandId = await client.runScript(config.instanceId, script, `AMS deploy ${name} ${tag}`);
  await update(deployment.id, { renderDeployId: `ssm:${commandId}` });
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const result = await client.commandResult(commandId, config.instanceId);
    if (['Pending', 'InProgress', 'Delayed', 'Cancelling'].includes(result.status)) continue;
    await appendLog(deployment.id, `--- instância ${config.instanceId} (${result.status})\n${result.stdout}\n${result.stderr}`.trim());
    if (result.status !== 'Success' || !result.stdout.includes('CONTAINER OK')) throw new Error(`A instância não conseguiu trocar o container (${result.status}). Veja render_logs type "build".`);
    break;
  }

  // 3. Live when the health check answers through the public URL.
  const health = `${service.url}${config.healthPath}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(health, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (response?.ok) {
      await appendLog(deployment.id, `Health ${health}: ${response.status}.`);
      await update(deployment.id, { status: 'live', finishedAt: new Date() });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`O container subiu, mas ${health} não respondeu 200 em ${HEALTH_TIMEOUT_MS / 60_000} minutos (veja render_logs type "app").`);
}

/** At startup: AWS deploys cut by a restart are run again (merge, image and container steps can be repeated). */
export async function resumeAwsDeploys(log: FastifyBaseLogger) {
  const pending = await prisma.deployment.findMany({ where: { finishedAt: null, serviceId: { startsWith: AWS_SERVICE_PREFIX } }, select: { id: true, startedAt: true } });
  for (const deployment of pending) {
    if (Date.now() - deployment.startedAt.getTime() > 2 * 3600_000) {
      await update(deployment.id, { status: 'error', error: 'O deploy foi interrompido por um reinício do Studio; peça de novo.', finishedAt: new Date() });
      continue;
    }
    log.info({ deploymentId: deployment.id }, 'Resuming an AWS deploy interrupted by a restart');
    void runAwsDeploy(deployment.id);
  }
}

// ---------------------------------------------------------------- variables

/** Variable names of a service (values are never read back). */
export async function awsEnvVarKeys(workspaceId: string, service: AwsService) {
  const { client } = await awsClientFor(workspaceId);
  if (service.kind === 'amplify') {
    const config = service.config as unknown as AmplifyConfig;
    return Object.keys((await client.amplifyBranch(config.appId, config.branchName)).environmentVariables ?? {});
  }
  return client.parameterNames((service.config as unknown as Ec2Config).parameterPath);
}

/** Creates or replaces variables (a generated value is a random secret nobody sees); they apply on the next deploy. */
export async function setAwsEnvVars(workspaceId: string, service: AwsService, vars: { key: string; value?: string; generate?: boolean }[]) {
  const { client } = await awsClientFor(workspaceId);
  const value = (entry: { value?: string; generate?: boolean }) => (entry.generate ? randomBytes(32).toString('base64url') : entry.value!);
  if (service.kind === 'amplify') {
    const config = service.config as unknown as AmplifyConfig;
    const branch = await client.amplifyBranch(config.appId, config.branchName);
    const merged = { ...(branch.environmentVariables ?? {}), ...Object.fromEntries(vars.map((entry) => [entry.key, value(entry)])) };
    await client.updateAmplifyBranchEnv(config.appId, config.branchName, merged);
    return;
  }
  const path = (service.config as unknown as Ec2Config).parameterPath;
  for (const entry of vars) await client.putParameter(`${path}${entry.key}`, value(entry));
}
