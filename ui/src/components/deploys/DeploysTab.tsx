import { useState } from 'react';
import { Link } from 'react-router';
import { type AwsServiceLink, type AwsSetupState, useAwsSettings, useAwsTargets, useRetryAwsSetup, useSetAwsService } from '../../api/aws';
import {
  type DeployEnvironment,
  type Deployment,
  type RenderServiceLink,
  environmentLabels,
  useAvailableRenderServices,
  useDeployments,
  useRenderSettings,
  useSetRenderService,
  useStartDeploy,
} from '../../api/render';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const ENVIRONMENTS: DeployEnvironment[] = ['HOMOLOGACAO', 'PRODUCAO'];

type Target = 'none' | 'render' | 'ec2' | 'amplify';

const targetLabels: Record<Target, string> = {
  none: 'Sem deploy',
  render: 'Render',
  ec2: 'Backend no EC2 (AWS)',
  amplify: 'Frontend no Amplify (AWS)',
};

/**
 * Where each project is published in homologation and production: nowhere, a Render service, or the workspace's AWS
 * account (an EC2 instance for a backend, an Amplify app for a frontend). The Studio creates and sets up the AWS side;
 * the workflows publish wherever this says.
 */
export function DeploysTab({ workspace }: { workspace: WorkspaceDetail }) {
  const render = useRenderSettings(workspace.id);
  const aws = useAwsSettings(workspace.id);
  const deployments = useDeployments(workspace.id);
  const deploy = useStartDeploy(workspace.id);
  const [editing, setEditing] = useState<{ projectId: string; environment: DeployEnvironment } | null>(null);
  const projects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);
  const find = <T extends { projectId: string; environment: DeployEnvironment }>(list: T[] | undefined, projectId: string, environment: DeployEnvironment) =>
    list?.find((entry) => entry.projectId === projectId && entry.environment === environment);
  const lastDeploy = (projectId: string, environment: DeployEnvironment) =>
    deployments.data?.find((entry) => entry.projectId === projectId && entry.environment === environment);

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Onde cada projeto é publicado em homologação e em produção. Os workflows fazem o merge do PR/MR e publicam no destino daqui; um projeto sem deploy não é
        publicado. Na AWS o Studio cria o que falta (instância, IP, DNS, Docker e Caddy; app do Amplify e domínio) usando a conta escolhida na aba Conectores
        {aws.data && !aws.data.connection && (
          <>
            {' '}
            — <span className="text-amber-300">este workspace ainda não tem conta da AWS</span> (
            <Link to="/guia/aws" className="text-accent hover:underline">
              passo a passo
            </Link>
            )
          </>
        )}
        .
      </p>
      <ErrorText error={render.error ?? aws.error ?? deploy.error} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/60 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Projeto</th>
              {ENVIRONMENTS.map((environment) => (
                <th key={environment} className="px-3 py-2 font-medium">
                  {environmentLabels[environment]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {projects.map((project) => (
              <tr key={project.id}>
                <td className="px-3 py-2 align-top font-medium">{project.name}</td>
                {ENVIRONMENTS.map((environment) => {
                  const awsService = find(aws.data?.services, project.id, environment);
                  const renderService = awsService ? undefined : find(render.data?.services, project.id, environment);
                  const last = lastDeploy(project.id, environment);
                  const isEditing = editing?.projectId === project.id && editing.environment === environment;
                  return (
                    <td key={environment} className={`px-3 py-2 align-top ${isEditing ? 'bg-accent/5' : ''}`}>
                      <DeployCell awsService={awsService} renderService={renderService} last={last} />
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setEditing({ projectId: project.id, environment })}>
                          {awsService || renderService ? 'Alterar' : 'Configurar'}
                        </button>
                        {(awsService || renderService) && (
                          <button
                            type="button"
                            className="text-xs text-accent hover:underline disabled:opacity-50"
                            disabled={deploy.isPending}
                            onClick={() =>
                              window.confirm(`Publicar agora ${project.name} em ${environmentLabels[environment].toLowerCase()}?`) &&
                              deploy.mutate({ projectId: project.id, environment })
                            }
                          >
                            Publicar agora
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <DeployForm
          key={`${editing.projectId}-${editing.environment}`}
          workspace={workspace}
          projectId={editing.projectId}
          environment={editing.environment}
          awsService={find(aws.data?.services, editing.projectId, editing.environment)}
          renderService={find(render.data?.services, editing.projectId, editing.environment)}
          renderConnected={Boolean(render.data?.connection)}
          awsConnected={Boolean(aws.data?.connection)}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function DeployCell({ awsService, renderService, last }: { awsService?: AwsServiceLink; renderService?: RenderServiceLink; last?: Deployment }) {
  if (!awsService && !renderService) return <span className="text-xs text-muted">Sem deploy</span>;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="info">{awsService ? (awsService.kind === 'ec2' ? 'EC2' : 'Amplify') : 'Render'}</Badge>
        <span className="font-medium">{awsService?.url?.replace(/^https?:\/\//, '') ?? renderService?.serviceName}</span>
        {(awsService?.branch ?? renderService?.branch) && <span className="text-muted">({awsService?.branch ?? renderService?.branch})</span>}
      </div>
      {awsService?.config.setup && <SetupLine setup={awsService.config.setup} />}
      {last && (
        <p className="text-muted">
          Último deploy: <span className={last.isSuccess ? 'text-emerald-300' : last.isFinished ? 'text-red-300' : 'text-amber-300'}>{last.statusLabel}</span> ·{' '}
          {timeAgo(last.startedAt)}
        </p>
      )}
    </div>
  );
}

function SetupLine({ setup }: { setup: AwsSetupState }) {
  if (setup.status === 'running') return <p className="text-amber-300">Configurando: {setup.step}…</p>;
  if (setup.status === 'failed') return <p className="text-red-300">Configuração falhou (abra em Alterar)</p>;
  if (setup.dnsManual && setup.dns.length > 0) return <p className="text-amber-300">Falta criar o DNS (abra em Alterar)</p>;
  return null;
}

function DeployForm({
  workspace,
  projectId,
  environment,
  awsService,
  renderService,
  renderConnected,
  awsConnected,
  onDone,
}: {
  workspace: WorkspaceDetail;
  projectId: string;
  environment: DeployEnvironment;
  awsService?: AwsServiceLink;
  renderService?: RenderServiceLink;
  renderConnected: boolean;
  awsConnected: boolean;
  onDone: () => void;
}) {
  const project = workspace.projects.find((entry) => entry.id === projectId);
  const initial: Target = awsService ? awsService.kind : renderService ? 'render' : 'none';
  const [target, setTarget] = useState<Target>(initial);
  const setAws = useSetAwsService(workspace.id);
  const setRender = useSetRenderService(workspace.id);
  const pending = setAws.isPending || setRender.isPending;

  const clear = async () => {
    if (awsService) await setAws.mutateAsync({ projectId, environment, kind: null });
    if (renderService) await setRender.mutateAsync({ projectId, environment, serviceId: null });
    onDone();
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {project?.name} — {environmentLabels[environment]}
        </p>
        <Button size="sm" onClick={onDone}>
          Fechar
        </Button>
      </div>
      <Field label="Destino">
        <Select value={target} onChange={(event) => setTarget(event.target.value as Target)} className="max-w-sm">
          {(Object.keys(targetLabels) as Target[]).map((value) => (
            <option key={value} value={value} disabled={(value === 'render' && !renderConnected) || ((value === 'ec2' || value === 'amplify') && !awsConnected)}>
              {targetLabels[value]}
              {value === 'render' && !renderConnected ? ' — sem conta do Render no workspace' : ''}
              {(value === 'ec2' || value === 'amplify') && !awsConnected ? ' — sem conta da AWS no workspace' : ''}
            </option>
          ))}
        </Select>
      </Field>

      {target === 'none' && (
        <div className="space-y-2">
          <p className="text-sm text-muted">O projeto não é publicado neste ambiente. O que já existe na AWS ou no Render não é apagado.</p>
          {initial !== 'none' && (
            <Button variant="danger" onClick={() => void clear()} disabled={pending}>
              Tirar o deploy deste ambiente
            </Button>
          )}
        </div>
      )}
      {target === 'render' && <RenderForm workspace={workspace} projectId={projectId} environment={environment} current={renderService} onDone={onDone} />}
      {(target === 'ec2' || target === 'amplify') && (
        <AwsForm
          key={target}
          workspace={workspace}
          projectId={projectId}
          environment={environment}
          kind={target}
          current={awsService?.kind === target ? awsService : undefined}
        />
      )}
      <ErrorText error={setAws.error ?? setRender.error} />
    </div>
  );
}

function RenderForm({
  workspace,
  projectId,
  environment,
  current,
  onDone,
}: {
  workspace: WorkspaceDetail;
  projectId: string;
  environment: DeployEnvironment;
  current?: RenderServiceLink;
  onDone: () => void;
}) {
  const available = useAvailableRenderServices(workspace.id, true);
  const setRender = useSetRenderService(workspace.id);
  const [serviceId, setServiceId] = useState(current?.serviceId ?? '');
  return (
    <div className="space-y-3">
      <Field label="Serviço do Render" hint={available.isLoading ? 'Buscando os serviços...' : undefined}>
        <Select value={serviceId} onChange={(event) => setServiceId(event.target.value)} className="max-w-md">
          <option value="">Escolha...</option>
          {available.data?.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
              {service.branch ? ` (${service.branch})` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="primary" disabled={!serviceId || setRender.isPending} onClick={() => setRender.mutate({ projectId, environment, serviceId }, { onSuccess: onDone })}>
        Salvar
      </Button>
      <ErrorText error={available.error ?? setRender.error} />
    </div>
  );
}

const NEW = '__new__';

function AwsForm({
  workspace,
  projectId,
  environment,
  kind,
  current,
}: {
  workspace: WorkspaceDetail;
  projectId: string;
  environment: DeployEnvironment;
  kind: 'ec2' | 'amplify';
  current?: AwsServiceLink;
}) {
  const targets = useAwsTargets(workspace.id, true);
  const save = useSetAwsService(workspace.id);
  const project = workspace.projects.find((entry) => entry.id === projectId);
  const config = (current?.config ?? {}) as Record<string, unknown>;
  const [url, setUrl] = useState(current?.url ?? '');
  const [branch, setBranch] = useState(current?.branch ?? project?.baseBranch ?? 'main');
  const [instanceId, setInstanceId] = useState(String(config.instanceId ?? NEW));
  const [instanceType, setInstanceType] = useState('t3.small');
  const [healthPath, setHealthPath] = useState(String(config.healthPath ?? '/health'));
  const [dockerfile, setDockerfile] = useState(String(config.dockerfile ?? ''));
  const [appId, setAppId] = useState(String(config.appId ?? NEW));
  const [outputDir, setOutputDir] = useState('dist');

  const error = (value: unknown) => (value && !Array.isArray(value) ? (value as { error: string }).error : null);
  const ec2 = Array.isArray(targets.data?.ec2Instances) ? targets.data.ec2Instances : [];
  const managed = Array.isArray(targets.data?.instances) ? targets.data.instances : [];
  // Studio instances first, then any other instance the SSM agent reports (set up by hand).
  const instanceOptions = [
    ...ec2.filter((entry) => entry.studio || managed.some((other) => other.instanceId === entry.instanceId)),
    ...managed.filter((entry) => !ec2.some((other) => other.instanceId === entry.instanceId)).map((entry) => ({ instanceId: entry.instanceId, name: entry.name, type: null, state: entry.online ? 'online' : 'offline', publicIp: entry.ip, studio: false })),
  ];
  const apps = Array.isArray(targets.data?.amplifyApps) ? targets.data.amplifyApps : [];
  const setup = current?.config.setup;
  const isNew = kind === 'ec2' ? instanceId === NEW : appId === NEW;

  const submit = () => {
    const confirmNew =
      kind === 'ec2' && isNew
        ? window.confirm(`Criar uma instância ${instanceType} na conta da AWS do workspace? Ela é cobrada enquanto existir (veja os custos no passo a passo).`)
        : true;
    if (!confirmNew) return;
    save.mutate(
      kind === 'ec2'
        ? {
            projectId,
            environment,
            kind,
            url,
            branch,
            ...(isNew ? { newInstanceType: instanceType } : { instanceId }),
            healthPath,
            ...(dockerfile && { dockerfile }),
          }
        : { projectId, environment, kind, branch, ...(url && { url }), ...(isNew ? { outputDir } : { appId }) },
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === 'ec2' ? (
          <>
            <Field label="Instância" hint={error(targets.data?.ec2Instances) ?? (targets.isLoading ? 'Buscando as instâncias...' : 'Vários backends podem dividir a mesma instância, cada um no seu endereço.')}>
              <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
                <option value={NEW}>Nova instância…</option>
                {instanceOptions.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.name ?? instance.instanceId} {instance.type ? `· ${instance.type}` : ''} {instance.state ? `· ${instance.state}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {instanceId === NEW && (
              <Field label="Tipo da nova instância" hint="t3.small (2 GB) basta para uma API; t3.medium (4 GB) se o banco rodar junto ou forem vários backends.">
                <Select value={instanceType} onChange={(event) => setInstanceType(event.target.value)}>
                  {(targets.data?.instanceTypes ?? ['t3.small']).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Endereço" hint="Ex.: https://api-hom.seudominio.com.br. O Studio aponta o DNS (se a zona estiver na conta) e o Caddy dá o HTTPS.">
              <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
            </Field>
            <Field label="Health check">
              <TextInput value={healthPath} onChange={(event) => setHealthPath(event.target.value)} />
            </Field>
            <Field label="Dockerfile (opcional)" hint="Vazio usa o Dockerfile da raiz.">
              <TextInput value={dockerfile} onChange={(event) => setDockerfile(event.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="App do Amplify" hint={error(targets.data?.amplifyApps) ?? 'Um app novo é ligado ao repositório com o token git do workspace, com build automático desligado.'}>
              <Select value={appId} onChange={(event) => setAppId(event.target.value)}>
                <option value={NEW}>Criar um app novo…</option>
                {apps.map((app) => (
                  <option key={app.appId} value={app.appId}>
                    {app.name} ({app.domain})
                  </option>
                ))}
              </Select>
            </Field>
            {appId === NEW && (
              <Field label="Pasta do build" hint="Onde o build deixa o site (Vite: dist; Create React App: build).">
                <TextInput value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
              </Field>
            )}
            <Field label="Endereço (opcional)" hint="Ex.: https://app-hom.seudominio.com.br. Vazio usa o do Amplify (https://<branch>.<app>.amplifyapp.com).">
              <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
            </Field>
          </>
        )}
        <Field label="Branch" hint="A branch base dos PR/MR deste projeto (a que é publicada).">
          <TextInput value={branch} onChange={(event) => setBranch(event.target.value)} />
        </Field>
      </div>
      {kind === 'ec2' && current && (
        <p className="text-xs text-muted">
          Porta do container: {String(config.port)} · imagem {String(config.ecrRepository)} · variáveis em Parameter Store {String(config.parameterPath)}
        </p>
      )}
      <Button variant="primary" onClick={submit} disabled={save.isPending || (kind === 'ec2' && !url)}>
        {save.isPending ? (isNew ? 'Criando na AWS...' : 'Conferindo na AWS...') : isNew ? (kind === 'ec2' ? 'Criar a instância e configurar' : 'Criar o app e configurar') : 'Salvar e configurar'}
      </Button>
      <ErrorText error={save.error ?? targets.error} />
      {current && setup && <SetupPanel workspaceId={workspace.id} serviceId={current.id} setup={setup} />}
    </div>
  );
}

function SetupPanel({ workspaceId, serviceId, setup }: { workspaceId: string; serviceId: string; setup: AwsSetupState }) {
  const retry = useRetryAwsSetup(workspaceId);
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Configuração na AWS</span>
        <Badge tone={setup.status === 'done' ? 'success' : setup.status === 'failed' ? 'danger' : 'warning'}>
          {setup.status === 'done' ? 'Pronta' : setup.status === 'failed' ? 'Falhou' : 'Em andamento'}
        </Badge>
        {setup.status === 'running' && <span className="text-xs text-muted">{setup.step}…</span>}
        {setup.status !== 'running' && (
          <Button size="sm" onClick={() => retry.mutate(serviceId)} disabled={retry.isPending}>
            Repetir a configuração
          </Button>
        )}
      </div>
      {setup.error && <p className="text-xs text-red-300">{setup.error}</p>}
      {setup.dns.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">
            {setup.dnsManual
              ? 'O domínio não está numa zona do Route 53 desta conta: crie estes registros no seu DNS e depois clique em "Repetir a configuração".'
              : 'Registros de DNS criados pelo Studio no Route 53:'}
          </p>
          <table className="text-xs">
            <tbody>
              {setup.dns.map((record) => (
                <tr key={`${record.name}-${record.type}`}>
                  <td className="py-0.5 pr-3 font-mono">{record.name}</td>
                  <td className="py-0.5 pr-3">{record.type}</td>
                  <td className="py-0.5 font-mono">{record.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={retry.error} />
    </div>
  );
}
