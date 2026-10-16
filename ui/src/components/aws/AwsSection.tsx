import { useState } from 'react';
import { type AwsServiceLink, useAwsAccounts, useAwsSettings, useAwsTargets, useSetAwsService, useSetWorkspaceAwsAccount } from '../../api/aws';
import { type DeployEnvironment, environmentLabels } from '../../api/render';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const ENVIRONMENTS: DeployEnvironment[] = ['HOMOLOGACAO', 'PRODUCAO'];

/**
 * The workspace's AWS account and where each project runs on AWS. A project set here deploys on AWS instead of
 * Render in that environment (the agents' tools stay the same).
 */
export function AwsSection({ workspace }: { workspace: WorkspaceDetail }) {
  const accounts = useAwsAccounts();
  const settings = useAwsSettings(workspace.id);
  const setAccount = useSetWorkspaceAwsAccount(workspace.id);
  const [editing, setEditing] = useState<{ projectId: string; environment: DeployEnvironment } | null>(null);
  const projects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);
  const connection = settings.data?.connection;
  const linked = (projectId: string, environment: DeployEnvironment) =>
    settings.data?.services.find((service) => service.projectId === projectId && service.environment === environment);

  if (accounts.data?.length === 0) return <p className="text-sm text-muted">Cadastre uma conta da AWS na página Conectores.</p>;

  return (
    <div className="space-y-4">
      <div className="max-w-md">
        <Select value={connection?.accountId ?? ''} onChange={(event) => setAccount.mutate(event.target.value || null)} disabled={setAccount.isPending}>
          <option value="">Nenhuma (sem deploy na AWS)</option>
          {accounts.data?.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label} ({account.region})
            </option>
          ))}
        </Select>
        <ErrorText error={setAccount.error ?? settings.error} />
      </div>

      {connection && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
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
                  <td className="px-3 py-2 font-medium">{project.name}</td>
                  {ENVIRONMENTS.map((environment) => {
                    const service = linked(project.id, environment);
                    return (
                      <td key={environment} className="px-3 py-2 align-top">
                        {service ? <ServiceSummary service={service} /> : <span className="text-xs text-muted">Render (ou nada)</span>}
                        <button type="button" className="ml-2 text-xs text-accent hover:underline" onClick={() => setEditing({ projectId: project.id, environment })}>
                          {service ? 'Alterar' : 'Usar AWS'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {connection && editing && (
        <ServiceForm
          key={`${editing.projectId}-${editing.environment}`}
          workspace={workspace}
          projectId={editing.projectId}
          environment={editing.environment}
          current={linked(editing.projectId, editing.environment)}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ServiceSummary({ service }: { service: AwsServiceLink }) {
  return (
    <span className="text-xs">
      <span className="font-medium">{service.kind === 'ec2' ? 'EC2' : 'Amplify'}</span> · {service.name}
      {service.url && <span className="text-muted"> · {service.url}</span>}
      {service.branch && <span className="text-muted"> ({service.branch})</span>}
    </span>
  );
}

function ServiceForm({
  workspace,
  projectId,
  environment,
  current,
  onDone,
}: {
  workspace: WorkspaceDetail;
  projectId: string;
  environment: DeployEnvironment;
  current: AwsServiceLink | undefined;
  onDone: () => void;
}) {
  const targets = useAwsTargets(workspace.id, true);
  const save = useSetAwsService(workspace.id);
  const project = workspace.projects.find((entry) => entry.id === projectId);
  const config = (current?.config ?? {}) as Record<string, string | number | undefined>;
  const [kind, setKind] = useState<'ec2' | 'amplify'>(current?.kind ?? 'ec2');
  const [url, setUrl] = useState(current?.url ?? '');
  const [branch, setBranch] = useState(current?.branch ?? project?.baseBranch ?? 'main');
  const [instanceId, setInstanceId] = useState(String(config.instanceId ?? ''));
  const [port, setPort] = useState(String(config.port ?? '8080'));
  const [healthPath, setHealthPath] = useState(String(config.healthPath ?? '/health'));
  const [dockerfile, setDockerfile] = useState(String(config.dockerfile ?? ''));
  const [appId, setAppId] = useState(String(config.appId ?? ''));
  const instances = Array.isArray(targets.data?.instances) ? targets.data.instances : [];
  const apps = Array.isArray(targets.data?.amplifyApps) ? targets.data.amplifyApps : [];
  const targetError = (value: unknown) => (value && !Array.isArray(value) ? (value as { error: string }).error : null);

  const submit = () =>
    save.mutate(
      kind === 'ec2'
        ? { projectId, environment, kind, url, branch, instanceId, port: Number(port), healthPath, ...(dockerfile && { dockerfile }) }
        : { projectId, environment, kind, branch, appId, ...(url && { url }) },
      { onSuccess: onDone },
    );

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">
        {project?.name} — {environmentLabels[environment]}
      </p>
      <div className="flex gap-2">
        {(['ec2', 'amplify'] as const).map((value) => (
          <Button key={value} size="sm" variant={kind === value ? 'primary' : undefined} onClick={() => setKind(value)}>
            {value === 'ec2' ? 'Backend no EC2' : 'Frontend no Amplify'}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === 'ec2' ? (
          <>
            <Field
              label="Instância (com o agente do SSM)"
              hint={
                targetError(targets.data?.instances) ??
                (targets.isLoading
                  ? 'Buscando as instâncias...'
                  : instances.length === 0
                    ? 'Nenhuma instância aparece no Systems Manager desta região. A instância precisa estar ligada, com o perfil de instância studio-ec2 (AmazonSSMManagedInstanceCore) e acesso de saída à internet; ela aparece em Systems Manager → Fleet Manager uns minutos depois.'
                    : undefined)
              }
            >
              <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
                <option value="">Escolha...</option>
                {instances.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.instanceId} {instance.name ? `(${instance.name})` : ''} {instance.online ? '' : '— offline'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="URL pública" hint="Ex.: https://api-hom.seudominio.com.br (o Caddy da instância encaminha para a porta).">
              <TextInput value={url} onChange={(event) => setUrl(event.target.value)} />
            </Field>
            <Field label="Porta do container">
              <TextInput value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
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
            <Field label="App do Amplify" hint={targetError(targets.data?.amplifyApps) ?? undefined}>
              <Select value={appId} onChange={(event) => setAppId(event.target.value)}>
                <option value="">Escolha...</option>
                {apps.map((app) => (
                  <option key={app.appId} value={app.appId}>
                    {app.name} ({app.domain})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="URL pública (opcional)" hint="Vazio usa a do Amplify (https://<branch>.<domínio>).">
              <TextInput value={url} onChange={(event) => setUrl(event.target.value)} />
            </Field>
          </>
        )}
        <Field label="Branch" hint="A branch base dos PR/MR deste projeto (a que é publicada).">
          <TextInput value={branch} onChange={(event) => setBranch(event.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={submit} disabled={save.isPending}>
          {save.isPending ? 'Conferindo na AWS...' : 'Salvar'}
        </Button>
        {current && (
          <Button variant="danger" onClick={() => save.mutate({ projectId, environment, kind: null }, { onSuccess: onDone })} disabled={save.isPending}>
            Voltar para o Render
          </Button>
        )}
        <Button onClick={onDone}>Cancelar</Button>
      </div>
      <ErrorText error={save.error ?? targets.error} />
    </div>
  );
}
