import { createHash, createHmac } from 'node:crypto';
import { HttpError } from '../../lib/errors.js';

/**
 * Minimal AWS client: Signature V4 over fetch, for the few calls the Studio needs (STS, SSM, ECR, CloudWatch,
 * CloudWatch Logs, Amplify). No SDK: the server keeps its small dependency list.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

type Json = any; // AWS responses are narrowed where they are read.

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function signRequest(input: {
  credentials: AwsCredentials;
  service: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  now?: Date;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.url.host, 'x-amz-date': amzDate };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const path = input.url.pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/') || '/';
  const canonical = [input.method, path, query, names.map((name) => `${name}:${lower[name]}\n`).join(''), names.join(';'), sha256(input.body)].join('\n');
  const scope = `${day}/${input.credentials.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.credentials.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

async function send(credentials: AwsCredentials, service: string, method: string, url: URL, body: string, headers: Record<string, string>) {
  // fetch sets Host itself (the same value that was signed).
  const { host: _host, ...signed } = signRequest({ credentials, service, method, url, headers, body });
  const response = await fetch(url, { method, headers: signed, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar à AWS (${service}).`);
  const text = await response.text();
  let data: Json = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    // XML services (EC2, IAM, Route 53) answer errors as <Code> and <Message>.
    const xml = typeof data === 'string' ? data : '';
    const code = data?.__type ?? data?.Error?.Code ?? data?.code ?? xmlText(xml, 'Code') ?? response.status;
    const message = data?.message ?? data?.Message ?? data?.Error?.Message ?? xmlText(xml, 'Message') ?? xml.slice(0, 300);
    if (response.status === 403 && /security token|signature|InvalidClientTokenId|UnrecognizedClient/i.test(`${code} ${message}`)) {
      throw new HttpError(422, 'Chave da AWS inválida.');
    }
    throw new HttpError(response.status === 403 ? 422 : 502, `AWS ${service}: ${String(code).split('#').pop()} ${message}`.trim());
  }
  return data;
}

/** Query-protocol services (EC2, IAM): one form POST with Action and Version; the answer is XML. */
async function queryCall(credentials: AwsCredentials, service: string, host: string, version: string, action: string, params: Record<string, string | number | boolean>) {
  const body = new URLSearchParams({ Action: action, Version: version, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) }).toString();
  return String(await send(credentials, service, 'POST', new URL(`https://${host}/`), body, { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }));
}

const decodeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text of the first <tag> (enough for the flat answers the Studio reads). */
export function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!.trim()) : null;
}

export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1]!);
}

export interface Ec2Instance {
  instanceId: string;
  name: string | null;
  type: string | null;
  state: string | null;
  publicIp: string | null;
  studio: boolean;
}

/** Instances of a DescribeInstances answer (each <instanceId> starts one; its tags come after it). */
export function parseInstances(xml: string): Ec2Instance[] {
  return xml
    .split('<instanceId>')
    .slice(1)
    .map((chunk) => {
      const tags = Object.fromEntries([...chunk.matchAll(/<key>([^<]*)<\/key>\s*<value>([^<]*)<\/value>/g)].map((match) => [match[1]!, decodeXml(match[2]!)]));
      return {
        instanceId: chunk.slice(0, chunk.indexOf('</instanceId>')).trim(),
        name: tags.Name ?? null,
        type: xmlText(chunk, 'instanceType'),
        state: xmlText(xmlText(chunk, 'instanceState') ?? '', 'name'),
        publicIp: xmlText(chunk, 'ipAddress'),
        studio: tags.studio === 'true',
      };
    });
}

/** A record Amplify asks for ("_x.domain. CNAME _y.acm-validations.aws." or "v2 CNAME d1.cloudfront.net"), as a full name. */
export function parseDnsRecord(record: string, domain: string): { name: string; type: string; value: string } | null {
  const parts = record.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const value = parts[parts.length - 1]!.replace(/\.$/, '');
  const type = parts[parts.length - 2]!.toUpperCase();
  const label = parts.length >= 3 ? parts[0]! : '';
  const name = label.endsWith('.') ? label.slice(0, -1) : label && label !== '@' ? `${label}.${domain}` : domain;
  return { name: name.toLowerCase(), type, value };
}

/** What the containers' instances may read and write: the /ams parameters (their .env) and the /ams log groups. */
const INSTANCE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: 'ssm:GetParametersByPath', Resource: 'arn:aws:ssm:*:*:parameter/ams/*' },
    { Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringLike: { 'kms:ViaService': 'ssm.*.amazonaws.com' } } },
    { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:log-group:/ams/*' },
  ],
};

/** CloudFront's fixed hosted zone, for alias records (Amplify serves through CloudFront). */
const CLOUDFRONT_ZONE = 'Z2FDTNDATAQYW2';

/** JSON-protocol services (SSM, ECR, CloudWatch Logs, CloudWatch): one POST with an X-Amz-Target. */
function jsonCall(credentials: AwsCredentials, service: string, host: string, target: string, version: '1.0' | '1.1', payload: unknown) {
  const url = new URL(`https://${host}/`);
  return send(credentials, service, 'POST', url, JSON.stringify(payload ?? {}), {
    'content-type': `application/x-amz-json-${version}`,
    'x-amz-target': target,
  });
}

export function createAwsClient(credentials: AwsCredentials) {
  const region = credentials.region;
  const ssm = (action: string, payload: unknown) => jsonCall(credentials, 'ssm', `ssm.${region}.amazonaws.com`, `AmazonSSM.${action}`, '1.1', payload);
  const ecr = (action: string, payload: unknown) =>
    jsonCall(credentials, 'ecr', `api.ecr.${region}.amazonaws.com`, `AmazonEC2ContainerRegistry_V20150921.${action}`, '1.1', payload);
  const logs = (action: string, payload: unknown) => jsonCall(credentials, 'logs', `logs.${region}.amazonaws.com`, `Logs_20140328.${action}`, '1.1', payload);
  const cloudwatch = (action: string, payload: unknown) =>
    jsonCall(credentials, 'monitoring', `monitoring.${region}.amazonaws.com`, `GraniteServiceVersion20100801.${action}`, '1.0', payload);
  const amplify = (method: string, path: string, payload?: unknown) =>
    send(credentials, 'amplify', method, new URL(`https://amplify.${region}.amazonaws.com${path}`), payload === undefined ? '' : JSON.stringify(payload), {
      'content-type': 'application/json',
    });
  const ec2 = (action: string, params: Record<string, string | number | boolean> = {}) => queryCall(credentials, 'ec2', `ec2.${region}.amazonaws.com`, '2016-11-15', action, params);
  // IAM and Route 53 are global: signed for us-east-1.
  const global = { ...credentials, region: 'us-east-1' };
  const iam = (action: string, params: Record<string, string | number | boolean> = {}) => queryCall(global, 'iam', 'iam.amazonaws.com', '2010-05-08', action, params);
  const route53 = async (method: string, path: string, body = '') =>
    String(await send(global, 'route53', method, new URL(`https://route53.amazonaws.com/2013-04-01${path}`), body, body ? { 'content-type': 'application/xml' } : {}));
  const notFound = (pattern: RegExp) => (error: unknown) => {
    if (!pattern.test(String((error as Error).message))) throw error;
    return null;
  };

  async function amplifyBranch(appId: string, branch: string) {
    const data = await amplify('GET', `/apps/${appId}/branches/${encodeURIComponent(branch)}`);
    return data.branch as { branchName: string; environmentVariables?: Record<string, string>; enableAutoBuild?: boolean; displayName?: string };
  }

  async function amplifyDomain(appId: string, domainName: string) {
    const data = await amplify('GET', `/apps/${appId}/domains/${encodeURIComponent(domainName)}`);
    const domain = data.domainAssociation;
    const certificate = (domain.certificateVerificationDNSRecord ?? domain.certificate?.certificateVerificationDNSRecord ?? null) as string | null;
    const records = [certificate, ...((domain.subDomains ?? []) as Json[]).map((entry) => entry.dnsRecord as string | undefined)]
      .filter((record): record is string => Boolean(record))
      .map((record) => parseDnsRecord(record, domainName))
      .filter((record) => record !== null);
    return { status: String(domain.domainStatus), reason: (domain.statusReason as string | undefined) ?? null, records };
  }

  return {
    /** Who the key is (also proves it works). */
    async identity(): Promise<{ account: string; arn: string }> {
      const url = new URL(`https://sts.${region}.amazonaws.com/`);
      const body = 'Action=GetCallerIdentity&Version=2011-06-15';
      const data = await send(credentials, 'sts', 'POST', url, body, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
      const result = data?.GetCallerIdentityResponse?.GetCallerIdentityResult;
      if (!result?.Account) throw new HttpError(502, 'AWS STS: resposta inesperada.');
      return { account: String(result.Account), arn: String(result.Arn) };
    },

    // ---------------------------------------------------------------- SSM (instances, commands, parameters)

    /** Instances managed by SSM (the agent is online), to choose the one that runs a backend. */
    async managedInstances(): Promise<{ instanceId: string; name: string | null; online: boolean; platform: string | null; ip: string | null }[]> {
      const data = await ssm('DescribeInstanceInformation', { MaxResults: 50 });
      return ((data?.InstanceInformationList ?? []) as Json[]).map((entry) => ({
        instanceId: entry.InstanceId,
        name: entry.ComputerName ?? null,
        online: entry.PingStatus === 'Online',
        platform: entry.PlatformName ?? null,
        ip: entry.IPAddress ?? null,
      }));
    },

    /** Runs a shell script on an instance (AWS-RunShellScript); returns the command id. */
    async runScript(instanceId: string, lines: string[], comment: string, timeoutSeconds = 900) {
      const data = await ssm('SendCommand', {
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Comment: comment.slice(0, 100),
        TimeoutSeconds: 600,
        Parameters: { commands: lines, executionTimeout: [String(timeoutSeconds)] },
      });
      return String(data.Command.CommandId);
    },

    /** Status of a command on an instance: Pending, InProgress, Success, Failed, TimedOut, Cancelled... */
    async commandResult(commandId: string, instanceId: string) {
      const data = await ssm('GetCommandInvocation', { CommandId: commandId, InstanceId: instanceId }).catch((error: unknown) => {
        // Right after SendCommand the invocation may not exist yet.
        if (String((error as Error).message).includes('InvocationDoesNotExist')) return { Status: 'Pending' };
        throw error;
      });
      return {
        status: String(data.Status) as 'Pending' | 'InProgress' | 'Delayed' | 'Success' | 'Cancelled' | 'TimedOut' | 'Failed' | 'Cancelling',
        stdout: String(data.StandardOutputContent ?? ''),
        stderr: String(data.StandardErrorContent ?? ''),
      };
    },

    /** Names of the parameters under a path (values are never read back here). */
    async parameterNames(path: string) {
      const names: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = await ssm('GetParametersByPath', { Path: path, Recursive: false, WithDecryption: false, MaxResults: 10, ...(token && { NextToken: token }) });
        for (const parameter of (data?.Parameters ?? []) as Json[]) names.push(String(parameter.Name).slice(path.length));
        token = data?.NextToken;
        if (!token) break;
      }
      return names;
    },

    async putParameter(name: string, value: string) {
      await ssm('PutParameter', { Name: name, Value: value, Type: 'SecureString', Overwrite: true });
    },

    // ---------------------------------------------------------------- ECR

    /** Docker login for the account's registry. */
    async registryLogin() {
      const data = await ecr('GetAuthorizationToken', {});
      const entry = data.authorizationData[0];
      const [user, password] = Buffer.from(String(entry.authorizationToken), 'base64').toString('utf8').split(':');
      return { registry: String(entry.proxyEndpoint).replace(/^https:\/\//, ''), user: user!, password: password! };
    },

    async ensureRepository(name: string) {
      await ecr('DescribeRepositories', { repositoryNames: [name] }).catch(async (error: unknown) => {
        if (!String((error as Error).message).includes('RepositoryNotFound')) throw error;
        await ecr('CreateRepository', { repositoryName: name, imageScanningConfiguration: { scanOnPush: false } });
      });
    },

    // ---------------------------------------------------------------- CloudWatch

    async logLines(group: string, input: { limit: number; text?: string; minutes?: number }) {
      const data = await logs('FilterLogEvents', {
        logGroupName: group,
        limit: input.limit,
        startTime: Date.now() - (input.minutes ?? 60) * 60_000,
        ...(input.text && { filterPattern: `"${input.text.replaceAll('"', '')}"` }),
      });
      return ((data?.events ?? []) as Json[]).slice(-input.limit).map((event) => ({ timestamp: new Date(Number(event.timestamp)).toISOString(), message: String(event.message ?? '').trimEnd() }));
    },

    /** Average of an EC2/CWAgent metric over a window, one point per period. */
    async metric(input: { namespace: string; name: string; instanceId: string; minutes: number }) {
      const end = new Date();
      const start = new Date(end.getTime() - input.minutes * 60_000);
      const period = Math.max(60, Math.ceil((input.minutes * 60) / 60 / 60) * 60);
      const data = await cloudwatch('GetMetricData', {
        StartTime: start.getTime() / 1000,
        EndTime: end.getTime() / 1000,
        MetricDataQueries: [
          {
            Id: 'm',
            MetricStat: { Metric: { Namespace: input.namespace, MetricName: input.name, Dimensions: [{ Name: 'InstanceId', Value: input.instanceId }] }, Period: period, Stat: 'Average' },
          },
        ],
      });
      const result = (data?.MetricDataResults ?? [])[0] ?? {};
      const times = (result.Timestamps ?? []) as (number | string)[];
      const values = (result.Values ?? []) as number[];
      return times
        .map((time, index) => ({ at: new Date(typeof time === 'number' ? time * 1000 : time).toISOString(), value: Math.round(values[index]! * 10) / 10 }))
        .sort((a, b) => a.at.localeCompare(b.at));
    },

    // ---------------------------------------------------------------- Amplify

    async amplifyApps(): Promise<{ appId: string; name: string; domain: string; repository: string | null }[]> {
      const data = await amplify('GET', '/apps?maxResults=50');
      return ((data?.apps ?? []) as Json[]).map((app) => ({ appId: app.appId, name: app.name, domain: app.defaultDomain, repository: app.repository ?? null }));
    },

    amplifyBranch,

    async updateAmplifyBranchEnv(appId: string, branch: string, environmentVariables: Record<string, string>) {
      await amplify('POST', `/apps/${appId}/branches/${encodeURIComponent(branch)}`, { environmentVariables });
    },

    /** Starts a build and deploy of the branch's latest commit (or the given one). */
    async startAmplifyJob(appId: string, branch: string, commitId?: string) {
      const data = await amplify('POST', `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs`, {
        jobType: 'RELEASE',
        ...(commitId && { commitId }),
      });
      return String(data.jobSummary.jobId);
    },

    /** PENDING, PROVISIONING, RUNNING, FAILED, SUCCEED, CANCELLING, CANCELLED; with each step's log URL. */
    async amplifyJob(appId: string, branch: string, jobId: string) {
      const data = await amplify('GET', `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs/${jobId}`);
      return {
        status: String(data.job.summary.status),
        commitId: (data.job.summary.commitId as string | undefined) ?? null,
        steps: ((data.job.steps ?? []) as Json[]).map((step) => ({ name: String(step.stepName), status: String(step.status), logUrl: (step.logUrl as string | undefined) ?? null })),
      };
    },

    async amplifyJobs(appId: string, branch: string, limit = 10) {
      const data = await amplify('GET', `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs?maxResults=${limit}`);
      return ((data?.jobSummaries ?? []) as Json[]).map((job) => ({ jobId: String(job.jobId), status: String(job.status), startTime: job.startTime, endTime: job.endTime ?? null, commitId: job.commitId ?? null }));
    },

    /**
     * An app connected to the repository (a GitHub token, or a GitLab/Bitbucket one Amplify uses to add its deploy key
     * and webhook), with automatic builds off: the Studio starts each one after the merge.
     */
    async createAmplifyApp(input: { name: string; repository: string; provider: 'GITHUB' | 'GITLAB'; token: string; buildSpec: string; customRules: { source: string; target: string; status: string }[] }) {
      const data = await amplify('POST', '/apps', {
        name: input.name,
        repository: input.repository,
        platform: 'WEB',
        ...(input.provider === 'GITHUB' ? { accessToken: input.token } : { oauthToken: input.token }),
        buildSpec: input.buildSpec,
        customRules: input.customRules,
        enableBranchAutoBuild: false,
      });
      return { appId: String(data.app.appId), domain: String(data.app.defaultDomain) };
    },

    async ensureAmplifyBranch(appId: string, branch: string) {
      const current = await amplifyBranch(appId, branch).catch(notFound(/NotFound/i));
      if (!current) await amplify('POST', `/apps/${appId}/branches`, { branchName: branch, enableAutoBuild: false, stage: 'PRODUCTION' });
    },

    /** A custom domain for the branch (the whole host, no prefix); the records it needs come from amplifyDomain. */
    async ensureAmplifyDomain(appId: string, domainName: string, branch: string) {
      const current = await amplifyDomain(appId, domainName).catch(notFound(/NotFound/i));
      if (!current) await amplify('POST', `/apps/${appId}/domains`, { domainName, subDomainSettings: [{ prefix: '', branchName: branch }], enableAutoSubDomain: false });
    },

    amplifyDomain,

    // ---------------------------------------------------------------- EC2

    async instances(ids?: string[]): Promise<Ec2Instance[]> {
      const params: Record<string, string> = {
        'Filter.1.Name': 'instance-state-name',
        'Filter.1.Value.1': 'pending',
        'Filter.1.Value.2': 'running',
        'Filter.1.Value.3': 'stopping',
        'Filter.1.Value.4': 'stopped',
      };
      ids?.forEach((id, index) => (params[`InstanceId.${index + 1}`] = id));
      return parseInstances(await ec2('DescribeInstances', params));
    },

    /** Latest Amazon Linux 2023 image (it already has the SSM agent). */
    async latestAmazonLinux() {
      const data = await ssm('GetParameter', { Name: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64' });
      return String(data.Parameter.Value);
    },

    /** Security group of the default VPC open to the web (80/443, for Caddy), created once. */
    async ensureWebSecurityGroup(name: string) {
      const found = xmlText(await ec2('DescribeSecurityGroups', { 'Filter.1.Name': 'group-name', 'Filter.1.Value.1': name }), 'groupId');
      if (found) return found;
      const groupId = xmlText(await ec2('CreateSecurityGroup', { GroupName: name, GroupDescription: 'Studio: HTTP e HTTPS (Caddy)' }), 'groupId');
      if (!groupId) throw new HttpError(502, 'AWS ec2: o security group não foi criado.');
      const params: Record<string, string | number> = { GroupId: groupId };
      [80, 443].forEach((port, index) => {
        const prefix = `IpPermissions.${index + 1}`;
        Object.assign(params, {
          [`${prefix}.IpProtocol`]: 'tcp',
          [`${prefix}.FromPort`]: port,
          [`${prefix}.ToPort`]: port,
          [`${prefix}.IpRanges.1.CidrIp`]: '0.0.0.0/0',
          [`${prefix}.Ipv6Ranges.1.CidrIpv6`]: '::/0',
        });
      });
      await ec2('AuthorizeSecurityGroupIngress', params);
      return groupId;
    },

    /** Launches a Studio instance (tag studio=true); a profile created a moment ago takes a few seconds to be usable. */
    async runInstance(input: { imageId: string; type: string; securityGroupId: string; profile: string; name: string; diskGb: number }) {
      const params = {
        ImageId: input.imageId,
        InstanceType: input.type,
        MinCount: 1,
        MaxCount: 1,
        'SecurityGroupId.1': input.securityGroupId,
        'IamInstanceProfile.Name': input.profile,
        'BlockDeviceMapping.1.DeviceName': '/dev/xvda',
        'BlockDeviceMapping.1.Ebs.VolumeSize': input.diskGb,
        'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
        'BlockDeviceMapping.1.Ebs.DeleteOnTermination': true,
        'MetadataOptions.HttpTokens': 'required',
        'TagSpecification.1.ResourceType': 'instance',
        'TagSpecification.1.Tag.1.Key': 'Name',
        'TagSpecification.1.Tag.1.Value': input.name,
        'TagSpecification.1.Tag.2.Key': 'studio',
        'TagSpecification.1.Tag.2.Value': 'true',
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const instance = parseInstances(await ec2('RunInstances', params))[0];
          if (!instance) throw new HttpError(502, 'AWS ec2: a instância não foi criada.');
          return instance.instanceId;
        } catch (error) {
          if (attempt >= 8 || !/instance profile|iamInstanceProfile/i.test(String((error as Error).message))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
      }
    },

    /** The instance's Elastic IP (a fixed address for the DNS), allocated and associated once. */
    async ensureElasticIp(instanceId: string) {
      const current = xmlText(await ec2('DescribeAddresses', { 'Filter.1.Name': 'instance-id', 'Filter.1.Value.1': instanceId }), 'publicIp');
      if (current) return current;
      const allocated = await ec2('AllocateAddress', {
        Domain: 'vpc',
        'TagSpecification.1.ResourceType': 'elastic-ip',
        'TagSpecification.1.Tag.1.Key': 'studio',
        'TagSpecification.1.Tag.1.Value': 'true',
      });
      await ec2('AssociateAddress', { InstanceId: instanceId, AllocationId: xmlText(allocated, 'allocationId') ?? '' });
      return xmlText(allocated, 'publicIp') ?? '';
    },

    // ---------------------------------------------------------------- IAM

    /** Role and instance profile of the Studio's instances (SSM, ECR, logs, the /ams parameters), created once. */
    async ensureInstanceProfile(name: string) {
      const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
      if (!(await iam('GetRole', { RoleName: name }).catch(notFound(/NoSuchEntity/)))) {
        await iam('CreateRole', { RoleName: name, AssumeRolePolicyDocument: JSON.stringify(trust), Description: 'Studio: instancias de deploy' });
      }
      for (const policy of ['AmazonSSMManagedInstanceCore', 'AmazonEC2ContainerRegistryReadOnly', 'CloudWatchAgentServerPolicy']) {
        await iam('AttachRolePolicy', { RoleName: name, PolicyArn: `arn:aws:iam::aws:policy/${policy}` });
      }
      await iam('PutRolePolicy', { RoleName: name, PolicyName: 'studio-parametros', PolicyDocument: JSON.stringify(INSTANCE_POLICY) });
      if (!(await iam('GetInstanceProfile', { InstanceProfileName: name }).catch(notFound(/NoSuchEntity/)))) {
        await iam('CreateInstanceProfile', { InstanceProfileName: name });
        await iam('AddRoleToInstanceProfile', { InstanceProfileName: name, RoleName: name });
      }
      return name;
    },

    // ---------------------------------------------------------------- Route 53

    /** The account's public hosted zone that holds a host (the most specific one), if any. */
    async hostedZoneFor(host: string) {
      const xml = await route53('GET', '/hostedzone?maxitems=100');
      const zones = xmlBlocks(xml, 'HostedZone').map((block) => ({
        id: (xmlText(block, 'Id') ?? '').replace('/hostedzone/', ''),
        name: (xmlText(block, 'Name') ?? '').replace(/\.$/, '').toLowerCase(),
        private: xmlText(block, 'PrivateZone') === 'true',
      }));
      const name = host.toLowerCase();
      return zones.filter((zone) => !zone.private && (name === zone.name || name.endsWith(`.${zone.name}`))).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
    },

    /** Points a name at a value (A, CNAME or an alias to CloudFront), replacing an A or CNAME of the other type there. */
    async upsertRecord(zoneId: string, record: { name: string; type: 'A' | 'CNAME'; value: string; alias?: boolean }) {
      const name = record.name.replace(/\.$/, '').toLowerCase();
      const existing = await route53('GET', `/hostedzone/${zoneId}/rrset?name=${encodeURIComponent(name)}&maxitems=5`);
      const conflicting = xmlBlocks(existing, 'ResourceRecordSet').filter((block) => {
        const type = xmlText(block, 'Type') ?? '';
        return (xmlText(block, 'Name') ?? '').replace(/\.$/, '').toLowerCase() === name && ['A', 'CNAME'].includes(type) && type !== record.type;
      });
      const target = record.alias
        ? `<AliasTarget><HostedZoneId>${CLOUDFRONT_ZONE}</HostedZoneId><DNSName>${escapeXml(record.value)}</DNSName><EvaluateTargetHealth>false</EvaluateTargetHealth></AliasTarget>`
        : `<TTL>300</TTL><ResourceRecords><ResourceRecord><Value>${escapeXml(record.value)}</Value></ResourceRecord></ResourceRecords>`;
      const changes = [
        ...conflicting.map((block) => `<Change><Action>DELETE</Action><ResourceRecordSet>${block}</ResourceRecordSet></Change>`),
        `<Change><Action>UPSERT</Action><ResourceRecordSet><Name>${escapeXml(name)}</Name><Type>${record.type}</Type>${target}</ResourceRecordSet></Change>`,
      ];
      await route53(
        'POST',
        `/hostedzone/${zoneId}/rrset/`,
        `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes>${changes.join('')}</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`,
      );
    },
  };
}

export type AwsClient = ReturnType<typeof createAwsClient>;
