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

/**
 * What the Studio set up in the account for a service (instance, IP, DNS, Docker and Caddy; Amplify domain), kept
 * in the service's config so the Deploys tab shows the progress and the DNS records to create by hand, if any.
 */
export interface SetupState {
  status: 'running' | 'done' | 'failed';
  step: string;
  error: string | null;
  dns: { name: string; type: string; value: string }[];
  /** No hosted zone of the account holds the host: the records above are created by hand. */
  dnsManual: boolean;
  updatedAt: string;
}

export interface Ec2Config {
  instanceId: string;
  ecrRepository: string;
  containerName: string;
  port: number;
  healthPath: string;
  logGroup: string;
  parameterPath: string;
  dockerfile?: string;
  setup?: SetupState;
}

export interface AmplifyConfig {
  appId: string;
  branchName: string;
  /** The app was created by the Studio (connected to the repository). */
  created?: boolean;
  setup?: SetupState;
}

/** Instance types offered for a new backend instance (x86: the images are built for linux/amd64). */
export const INSTANCE_TYPES = ['t3.micro', 't3.small', 't3.medium', 't3.large', 't3.xlarge'] as const;
const INSTANCE_PROFILE = 'studio-ec2';
const SECURITY_GROUP = 'studio-web';
const FIRST_PORT = 8080;

/** React/Vite single-page apps: any path that is not a file is the index. */
const SPA_RULES = [{ source: '</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>', target: '/index.html', status: '200' }];

/**
 * Build of a front connected by the Studio: the package manager comes from the lockfile (pnpm 9 for lockfile 9, as
 * corepack may pull a pnpm that does not run on Amplify's Node), the output from the project (default dist).
 */
export function amplifyBuildSpec(outputDir: string) {
  return [
    'version: 1',
    'frontend:',
    '  phases:',
    '    preBuild:',
    '      commands:',
    '        - if [ -f pnpm-lock.yaml ]; then (grep -Eq "^lockfileVersion.{1,3}9" pnpm-lock.yaml && npm install -g pnpm@9 || npm install -g pnpm@8) && pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; else npm ci; fi',
    '    build:',
    '      commands:',
    '        - if [ -f pnpm-lock.yaml ]; then pnpm run build; elif [ -f yarn.lock ]; then yarn build; else npm run build; fi',
    '  artifacts:',
    `    baseDirectory: ${outputDir}`,
    '    files:',
    "      - '**/*'",
    '  cache:',
    '    paths:',
    '      - node_modules/**/*',
    '',
  ].join('\n');
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
  const failed = (error: Error) => ({ error: permissionHint(error.message) });
  const [instances, ec2Instances, apps] = await Promise.all([
    client.managedInstances().catch(failed),
    client.instances().catch(failed),
    client.amplifyApps().catch(failed),
  ]);
  return { instances, ec2Instances, amplifyApps: apps, instanceTypes: INSTANCE_TYPES };
}

/** A key with the first (smaller) policy cannot create things: say what to change instead of the raw AWS error. */
function permissionHint(message: string) {
  return /UnauthorizedOperation|AccessDenied|not authorized/i.test(message)
    ? `A chave da AWS do workspace não tem permissão para isso: atualize a política do usuário IAM com a do passo a passo (Conectores → AWS). Detalhe: ${message.slice(0, 200)}`
    : message;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

export type AwsServiceInput =
  | {
      projectId: string;
      environment: DeployEnvironment;
      kind: 'ec2';
      url: string;
      branch: string;
      /** An instance the account already has; without it, newInstanceType creates one. */
      instanceId?: string;
      newInstanceType?: string;
      port?: number;
      healthPath?: string;
      dockerfile?: string;
    }
  | { projectId: string; environment: DeployEnvironment; kind: 'amplify'; url?: string; branch: string; appId?: string; outputDir?: string }
  | { projectId: string; environment: DeployEnvironment; kind: null };

/**
 * Sets (or clears, with kind null) where a project runs on AWS in an environment, creating what is missing: a new
 * instance for a backend, an app connected to the repository for a frontend. The rest (IP, DNS, Docker, Caddy, the
 * front's domain) is set up in the background. A project deploys to one place per environment: this replaces Render.
 */
export async function setAwsService(workspaceId: string, input: AwsServiceInput) {
  const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId } });
  if (!project) throw notFound('Projeto não encontrado neste workspace.');
  const where = { projectId: input.projectId, environment: input.environment };
  if (input.kind === null) {
    await prisma.awsService.deleteMany({ where });
    return getAwsSettings(workspaceId);
  }
  const { client } = await awsClientFor(workspaceId);
  const current = await prisma.awsService.findUnique({ where: { projectId_environment: where } });
  const env = input.environment === 'HOMOLOGACAO' ? 'hom' : 'prod';
  const base = `ams-${slug(project.name)}-${env}`;
  let name: string;
  let url: string | null;
  let config: Ec2Config | AmplifyConfig;
  try {
    if (input.kind === 'ec2') {
      const instanceId = input.instanceId || (await launchInstance(client, `studio-${slug(project.name)}-${env}`, input.newInstanceType));
      if (input.instanceId) await assertInstance(client, input.instanceId);
      const previous = current?.kind === 'ec2' ? (current.config as unknown as Ec2Config) : null;
      name = base;
      url = input.url.replace(/\/+$/, '');
      config = {
        instanceId,
        ecrRepository: base,
        containerName: base,
        port: input.port ?? (previous?.instanceId === instanceId ? previous.port : await freePort(instanceId, current?.id ?? null)),
        healthPath: input.healthPath || '/health',
        logGroup: `/ams/${base}`,
        parameterPath: `/ams/${base}/`,
        ...(input.dockerfile && { dockerfile: input.dockerfile }),
      };
    } else {
      let appId = input.appId;
      let created = current?.kind === 'amplify' && (current.config as unknown as AmplifyConfig).appId === appId && Boolean((current.config as unknown as AmplifyConfig).created);
      if (!appId) {
        appId = await createAmplifyApp(workspaceId, project, `${slug(project.name)}-${env}`, input.outputDir || 'dist');
        created = true;
      }
      await client.ensureAmplifyBranch(appId, input.branch);
      const app = (await client.amplifyApps()).find((entry) => entry.appId === appId);
      name = `${app?.name ?? appId}/${input.branch}`;
      url = (input.url || `https://${input.branch}.${app?.domain ?? ''}`).replace(/\/+$/, '');
      config = { appId, branchName: input.branch, ...(created && { created: true }) };
    }
  } catch (error) {
    throw new HttpError(error instanceof HttpError ? error.statusCode : 502, permissionHint(error instanceof Error ? error.message : String(error)));
  }
  const data = { workspaceId, kind: input.kind, name, url, branch: input.branch, config: config as unknown as Prisma.InputJsonValue };
  const service = await prisma.awsService.upsert({ where: { projectId_environment: where }, create: { ...where, ...data }, update: data });
  await prisma.renderService.deleteMany({ where });
  void runAwsSetup(service.id);
  return getAwsSettings(workspaceId);
}

/** A new Studio instance: its role and instance profile, the web security group and Amazon Linux 2023, all created once. */
async function launchInstance(client: AwsClient, name: string, type: string | undefined) {
  if (!type || !(INSTANCE_TYPES as readonly string[]).includes(type)) throw new HttpError(422, 'Escolha uma instância ou o tipo de uma nova.');
  const [profile, securityGroupId, imageId] = await Promise.all([client.ensureInstanceProfile(INSTANCE_PROFILE), client.ensureWebSecurityGroup(SECURITY_GROUP), client.latestAmazonLinux()]);
  return client.runInstance({ imageId, type, securityGroupId, profile, name, diskGb: 30 });
}

async function assertInstance(client: AwsClient, instanceId: string) {
  const ec2 = await client.instances([instanceId]).catch(() => []);
  if (ec2.length > 0) return;
  if ((await client.managedInstances()).some((entry) => entry.instanceId === instanceId)) return;
  throw new HttpError(422, 'Instância não encontrada nesta conta/região.');
}

/** The first container port no other service uses on the instance (several backends can share one). */
async function freePort(instanceId: string, serviceId: string | null) {
  const services = await prisma.awsService.findMany({ where: { kind: 'ec2', ...(serviceId && { NOT: { id: serviceId } }) } });
  const used = new Set(services.map((entry) => entry.config as unknown as Ec2Config).filter((config) => config.instanceId === instanceId).map((config) => config.port));
  let port = FIRST_PORT;
  while (used.has(port)) port++;
  return port;
}

/** An Amplify app connected to the project's repository with the workspace's git token. */
async function createAmplifyApp(workspaceId: string, project: { name: string; gitRemoteUrl: string | null }, name: string, outputDir: string) {
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, 'O projeto não tem remote para ligar ao Amplify.');
  const git = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
  const { client } = await awsClientFor(workspaceId);
  try {
    const app = await client.createAmplifyApp({
      name,
      repository: `https://${remote.host}/${remote.path}`,
      provider: git.provider as 'GITHUB' | 'GITLAB',
      token: secrets.decrypt(git.tokenEncrypted),
      buildSpec: amplifyBuildSpec(outputDir),
      customRules: SPA_RULES,
    });
    return app.appId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      422,
      `O Amplify não conseguiu se ligar ao repositório com o token do workspace (${message.slice(0, 200)}). O token precisa poder criar deploy key e webhook (no GitLab, papel Maintainer e escopo api). Se não der, crie o app no console do Amplify e escolha-o aqui.`,
    );
  }
}

// ---------------------------------------------------------------- setup

const settingUp = new Set<string>();
const SETUP_POLL_MS = 15_000;

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_MS));
  }
}

/**
 * Sets up what a service needs in the account, from where it stopped (every step can be repeated): for a backend, the
 * running instance, its Elastic IP, the DNS record, Docker and Caddy; for a front, its custom domain and DNS records.
 */
export async function runAwsSetup(serviceId: string) {
  if (settingUp.has(serviceId)) return;
  settingUp.add(serviceId);
  const record = async (patch: Partial<SetupState>) => {
    const service = await prisma.awsService.findUnique({ where: { id: serviceId } });
    if (!service) return;
    const config = service.config as unknown as Ec2Config | AmplifyConfig;
    const setup: SetupState = { status: 'running', step: '', error: null, dns: [], dnsManual: false, ...config.setup, ...patch, updatedAt: new Date().toISOString() };
    await prisma.awsService.update({ where: { id: serviceId }, data: { config: { ...config, setup } as unknown as Prisma.InputJsonValue } });
  };
  try {
    const service = await prisma.awsService.findUniqueOrThrow({ where: { id: serviceId } });
    const { client } = await awsClientFor(service.workspaceId);
    await record({ status: 'running', step: 'Começando', error: null });
    if (service.kind === 'ec2') await setupEc2(service, client, record);
    else await setupAmplify(service, client, record);
    await record({ status: 'done', step: 'Pronto' });
  } catch (error) {
    await record({ status: 'failed', error: permissionHint(error instanceof Error ? error.message.slice(0, 500) : String(error)) }).catch(() => undefined);
  } finally {
    settingUp.delete(serviceId);
  }
}

async function setupEc2(service: AwsService, client: AwsClient, record: (patch: Partial<SetupState>) => Promise<void>) {
  const config = service.config as unknown as Ec2Config;
  const host = new URL(service.url!).hostname;
  await record({ step: 'Esperando a instância ligar' });
  await waitFor(async () => (await client.instances([config.instanceId]))[0]?.state === 'running', 10 * 60_000, 'A instância não ligou em 10 minutos.');
  await record({ step: 'IP fixo (Elastic IP)' });
  const ip = await client.ensureElasticIp(config.instanceId);
  await record({ step: 'DNS' });
  const zone = await client.hostedZoneFor(host).catch(() => null);
  if (zone) await client.upsertRecord(zone.id, { name: host, type: 'A', value: ip });
  await record({ dns: [{ name: host, type: 'A', value: ip }], dnsManual: !zone });
  await record({ step: 'Esperando o agente do SSM na instância' });
  await waitFor(async () => (await client.managedInstances()).some((entry) => entry.instanceId === config.instanceId && entry.online), 15 * 60_000, 'A instância não apareceu no Systems Manager em 15 minutos.');
  await record({ step: 'Instalando Docker e Caddy' });
  const result = await runOnInstance(client, config.instanceId, [...BOOTSTRAP, ...caddySite(host, config.port, config.containerName), 'echo "INSTANCIA OK"'], `AMS setup ${config.containerName}`);
  if (!result.stdout.includes('INSTANCIA OK')) throw new Error(`A configuração da instância falhou: ${`${result.stderr}\n${result.stdout}`.trim().slice(-400)}`);
}

async function setupAmplify(service: AwsService, client: AwsClient, record: (patch: Partial<SetupState>) => Promise<void>) {
  const config = service.config as unknown as AmplifyConfig;
  const host = service.url ? new URL(service.url).hostname : null;
  if (!host || host.endsWith('.amplifyapp.com')) return;
  await record({ step: 'Domínio no Amplify' });
  await client.ensureAmplifyDomain(config.appId, host, config.branchName);
  await record({ step: 'Registros de DNS' });
  const domain = await waitFor(
    async () => {
      const current = await client.amplifyDomain(config.appId, host);
      return current.records.some((entry) => entry.value.endsWith('.cloudfront.net')) || current.status === 'AVAILABLE' ? current : null;
    },
    10 * 60_000,
    'O Amplify não informou os registros de DNS do domínio em 10 minutos.',
  );
  const zone = await client.hostedZoneFor(host).catch(() => null);
  if (zone) {
    for (const entry of domain.records) {
      // The host itself points at CloudFront with an alias (it may be the zone's apex, where a CNAME is not allowed).
      if (entry.name === host) await client.upsertRecord(zone.id, { name: host, type: 'A', value: entry.value, alias: true });
      else await client.upsertRecord(zone.id, { name: entry.name, type: 'CNAME', value: entry.value });
    }
  }
  await record({ dns: domain.records, dnsManual: !zone });
  if (!zone) return;
  await record({ step: 'Ativando o domínio (o Amplify leva até 30 minutos)' });
  await waitFor(
    async () => {
      const current = await client.amplifyDomain(config.appId, host);
      if (current.status === 'FAILED') throw new Error(`O Amplify não ativou o domínio: ${current.reason ?? 'sem motivo informado'}.`);
      return current.status === 'AVAILABLE';
    },
    45 * 60_000,
    'O domínio não ficou disponível no Amplify em 45 minutos.',
  );
}

export async function retryAwsSetup(workspaceId: string, serviceId: string) {
  const service = await prisma.awsService.findFirst({ where: { id: serviceId, workspaceId } });
  if (!service) throw notFound('Deploy da AWS não encontrado neste workspace.');
  void runAwsSetup(service.id);
  return getAwsSettings(workspaceId);
}

/** At startup: setups cut by a restart go on from where they stopped. */
export async function resumeAwsSetups() {
  const services = await prisma.awsService.findMany();
  for (const service of services) if ((service.config as unknown as Ec2Config | AmplifyConfig).setup?.status === 'running') void runAwsSetup(service.id);
}

/** Runs a script on an instance and waits for it to end; fails unless it ends well. */
async function runOnInstance(client: AwsClient, instanceId: string, lines: string[], comment: string) {
  const commandId = await client.runScript(instanceId, lines, comment);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const result = await client.commandResult(commandId, instanceId);
    if (['Pending', 'InProgress', 'Delayed', 'Cancelling'].includes(result.status)) continue;
    if (result.status !== 'Success') throw new Error(`O comando na instância terminou como ${result.status}: ${`${result.stderr}\n${result.stdout}`.trim().slice(-400)}`);
    return { commandId, ...result };
  }
}

/** Docker, Caddy (HTTPS by Let's Encrypt, one file per site) and the memory metric; each step skips what is there. */
const BOOTSTRAP = [
  'set -e',
  'command -v docker >/dev/null || dnf install -y docker || yum install -y docker || (apt-get update && apt-get install -y docker.io)',
  'systemctl enable --now docker',
  'if ! command -v caddy >/dev/null; then ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/"); curl -fsSL -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=$ARCH"; chmod +x /usr/local/bin/caddy; fi',
  'id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy',
  'mkdir -p /etc/caddy/sites && touch /etc/caddy/Caddyfile',
  'if ! systemctl cat caddy >/dev/null 2>&1; then CADDY=$(command -v caddy); printf "%s\\n" "[Unit]" "Description=Caddy" "After=network-online.target" "Wants=network-online.target" "[Service]" "User=caddy" "Group=caddy" "ExecStart=$CADDY run --environ --config /etc/caddy/Caddyfile --adapter caddyfile" "ExecReload=$CADDY reload --config /etc/caddy/Caddyfile --adapter caddyfile --force" "AmbientCapabilities=CAP_NET_BIND_SERVICE" "Restart=on-failure" "[Install]" "WantedBy=multi-user.target" > /etc/systemd/system/caddy.service; systemctl daemon-reload; fi',
  'systemctl enable --now caddy',
  "(command -v /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl >/dev/null || dnf install -y amazon-cloudwatch-agent) >/dev/null 2>&1 && printf '%s' '{\"metrics\":{\"append_dimensions\":{\"InstanceId\":\"${aws:InstanceId}\"},\"metrics_collected\":{\"mem\":{\"measurement\":[\"mem_used_percent\"]}}}}' > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json && /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json >/dev/null || true",
];

/**
 * The service's Caddy site: the host to the container's port, in its own file (a host already in the main Caddyfile,
 * from a manual setup, is left there). A Caddy that rejects the configuration does not stop the deploy.
 */
export function caddySite(host: string, port: number, name: string) {
  const pattern = host.replace(/\./g, '\\.');
  return [
    'mkdir -p /etc/caddy/sites && touch /etc/caddy/Caddyfile',
    "grep -q '^import /etc/caddy/sites/' /etc/caddy/Caddyfile || printf '\\nimport /etc/caddy/sites/*.caddy\\n' >> /etc/caddy/Caddyfile",
    `if grep -qE '^[[:space:]]*${pattern}[[:space:]]*\\{' /etc/caddy/Caddyfile; then rm -f /etc/caddy/sites/${name}.caddy; else printf '%s {\\n  reverse_proxy 127.0.0.1:${port}\\n}\\n' '${host}' > /etc/caddy/sites/${name}.caddy; fi`,
    '(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && (systemctl reload caddy || systemctl restart caddy)) || echo "AVISO: o Caddy não aceitou a configuração"',
  ];
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
    ...(service.url ? caddySite(new URL(service.url).hostname, config.port, name) : []),
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
