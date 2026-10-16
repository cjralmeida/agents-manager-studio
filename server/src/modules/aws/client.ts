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
    const code = data?.__type ?? data?.Error?.Code ?? data?.code ?? response.status;
    const message = data?.message ?? data?.Message ?? data?.Error?.Message ?? (typeof data === 'string' ? data.slice(0, 300) : '');
    if (response.status === 403 && /security token|signature|InvalidClientTokenId|UnrecognizedClient/i.test(`${code} ${message}`)) {
      throw new HttpError(422, 'Chave da AWS inválida.');
    }
    throw new HttpError(response.status === 403 ? 422 : 502, `AWS ${service}: ${String(code).split('#').pop()} ${message}`.trim());
  }
  return data;
}

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

    async amplifyBranch(appId: string, branch: string) {
      const data = await amplify('GET', `/apps/${appId}/branches/${encodeURIComponent(branch)}`);
      return data.branch as { branchName: string; environmentVariables?: Record<string, string>; enableAutoBuild?: boolean; displayName?: string };
    },

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
  };
}

export type AwsClient = ReturnType<typeof createAwsClient>;
