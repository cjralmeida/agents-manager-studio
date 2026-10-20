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

type Editing = { projectId: string; environment: DeployEnvironment; isNew: boolean };

/**
 * Where each project is published in homologation and production: nowhere, a Render service, or the workspace's AWS
 * account (an EC2 instance for a backend, an Amplify app for a frontend). The Studio creates and sets up the AWS side;
 * the workflows publish wherever this says. Only projects with a deploy are listed; "+ Novo deploy" adds one.
 */
export function DeploysTab({ workspace }: { workspace: WorkspaceDetail }) {
  const render = useRenderSettings(workspace.id);
  const aws = useAwsSettings(workspace.id);
  const deployments = useDeployments(workspace.id);
  const deploy = useStartDeploy(workspace.id);
  const [editing, setEditing] = useState<Editing | null>(null);
  const projects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);
  const find = <T extends { projectId: string; environment: DeployEnvironment }>(list: T[] | undefined, projectId: string, environment: DeployEnvironment) =>
    list?.find((entry) => entry.projectId === projectId && entry.environment === environment);
  const awsFor = (projectId: string, environment: DeployEnvironment) => find(aws.data?.services, projectId, environment);
  const renderFor = (projectId: string, environment: DeployEnvironment) =>
    awsFor(projectId, environment) ? undefined : find(render.data?.services, projectId, environment);
  const hasDeploy = (projectId: string) => ENVIRONMENTS.some((environment) => awsFor(projectId, environment) ?? renderFor(projectId, environment));
  const configured = projects.filter((project) => hasDeploy(project.id));
  const withoutDeploy = projects.filter((project) => !hasDeploy(project.id));
  const loading = render.isLoading || aws.isLoading;
  const addNew = () => withoutDeploy[0] && setEditing({ projectId: withoutDeploy[0].id, environment: 'HOMOLOGACAO', isNew: true });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-3xl text-sm text-muted">
          Onde cada projeto é publicado em homologação e em produção. Os workflows fazem o merge do PR/MR e publicam no destino daqui. Na AWS o Studio cria o que
          falta (instância, IP, DNS, Docker e Caddy; app do Amplify e domínio) usando a conta escolhida na aba Conectores
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
        <Button variant="primary" onClick={addNew} disabled={withoutDeploy.length === 0} title={withoutDeploy.length === 0 ? 'Todos os projetos já têm deploy' : undefined}>
          + Novo deploy
        </Button>
      </div>
      <ErrorText error={render.error ?? aws.error ?? deploy.error} />

      {!loading && configured.length === 0 && (
        <button
          type="button"
          onClick={addNew}
          disabled={withoutDeploy.length === 0}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center text-muted transition-colors hover:border-accent/60 hover:text-gray-200"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-2xl text-accent">+</span>
          <span className="text-sm font-medium">Nenhum projeto com deploy configurado</span>
          <span className="text-xs">Escolha um projeto e onde ele é publicado em homologação e em produção.</span>
        </button>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {configured.map((project) => (
          <section key={project.id} className="overflow-hidden rounded-xl border border-border bg-panel/40">
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h3 className="font-semibold">{project.name}</h3>
              {project.baseBranch && <span className="font-mono text-xs text-muted">{project.baseBranch}</span>}
            </header>
            <div className="divide-y divide-border">
              {ENVIRONMENTS.map((environment) => (
                <EnvironmentRow
                  key={environment}
                  environment={environment}
                  awsService={awsFor(project.id, environment)}
                  renderService={renderFor(project.id, environment)}
                  last={deployments.data?.find((entry) => entry.projectId === project.id && entry.environment === environment)}
                  deploying={deploy.isPending}
                  onEdit={() => setEditing({ projectId: project.id, environment, isNew: false })}
                  onDeploy={() =>
                    window.confirm(`Publicar agora ${project.name} em ${environmentLabels[environment].toLowerCase()}?`) &&
                    deploy.mutate({ projectId: project.id, environment })
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-6" onClick={() => setEditing(null)}>
          <div onClick={(event) => event.stopPropagation()} className="w-full max-w-3xl space-y-4 rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">
                  {editing.isNew
                    ? 'Novo deploy'
                    : `${workspace.projects.find((entry) => entry.id === editing.projectId)?.name} — ${environmentLabels[editing.environment]}`}
                </h2>
                <p className="mt-1 text-xs text-muted">Um destino por ambiente: escolher um tira o outro daquele ambiente.</p>
              </div>
              <Button size="sm" onClick={() => setEditing(null)}>
                Fechar
              </Button>
            </div>
            {editing.isNew && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Projeto">
                  <Select value={editing.projectId} onChange={(event) => setEditing({ ...editing, projectId: event.target.value })}>
                    {withoutDeploy.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Ambiente" hint="O outro ambiente pode ser configurado depois, no card do projeto.">
                  <Select value={editing.environment} onChange={(event) => setEditing({ ...editing, environment: event.target.value as DeployEnvironment })}>
                    {ENVIRONMENTS.map((environment) => (
                      <option key={environment} value={environment}>
                        {environmentLabels[environment]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <DeployForm
              key={`${editing.projectId}-${editing.environment}`}
              workspace={workspace}
              projectId={editing.projectId}
              environment={editing.environment}
              awsService={awsFor(editing.projectId, editing.environment)}
              renderService={renderFor(editing.projectId, editing.environment)}
              renderConnected={Boolean(render.data?.connection)}
              awsConnected={Boolean(aws.data?.connection)}
              onDone={() => setEditing(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const targetBadges: Record<Exclude<Target, 'none'>, string> = { render: 'Render', ec2: 'EC2', amplify: 'Amplify' };

function EnvironmentRow({
  environment,
  awsService,
  renderService,
  last,
  deploying,
  onEdit,
  onDeploy,
}: {
  environment: DeployEnvironment;
  awsService?: AwsServiceLink;
  renderService?: RenderServiceLink;
  last?: Deployment;
  deploying: boolean;
  onEdit: () => void;
  onDeploy: () => void;
}) {
  const label = <span className="w-28 shrink-0 pt-0.5 text-xs font-medium tracking-wide text-muted uppercase">{environmentLabels[environment]}</span>;
  if (!awsService && !renderService) {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        {label}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-dashed border-border px-3 py-1 text-xs text-muted transition-colors hover:border-accent/60 hover:text-accent"
        >
          + Configurar {environmentLabels[environment].toLowerCase()}
        </button>
      </div>
    );
  }
  const url = awsService?.url ?? renderService?.url ?? null;
  const branch = awsService?.branch ?? renderService?.branch;
  const dot = !last ? 'bg-border' : last.isSuccess ? 'bg-emerald-400' : last.isFinished ? 'bg-red-400' : 'animate-pulse bg-amber-400';
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      {label}
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{targetBadges[awsService?.kind ?? 'render']}</Badge>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="truncate font-medium hover:text-accent hover:underline">
              {url.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span className="truncate font-medium">{renderService?.serviceName}</span>
          )}
          {branch && <span className="rounded bg-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted">{branch}</span>}
        </div>
        {awsService?.config.setup && <SetupLine setup={awsService.config.setup} />}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          {last ? `${last.statusLabel} · ${timeAgo(last.startedAt)}` : 'Ainda sem deploy pelo Studio'}
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" onClick={onDeploy} disabled={deploying}>
          Publicar
        </Button>
        <Button size="sm" onClick={onEdit}>
          Alterar
        </Button>
      </div>
    </div>
  );
}

function SetupLine({ setup }: { setup: AwsSetupState }) {
  if (setup.status === 'running') return <p className="text-xs text-amber-300">Configurando: {setup.step}…</p>;
  if (setup.status === 'failed') return <p className="text-xs text-red-300">A configuração na AWS falhou (abra em Alterar)</p>;
  if (setup.dnsManual && setup.dns.length > 0) return <p className="text-xs text-amber-300">Falta criar o DNS (abra em Alterar)</p>;
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
    <div className="space-y-4">
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
