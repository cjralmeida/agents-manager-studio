import { type FormEvent, useState } from 'react';
import {
  type DeployEnvironment,
  environmentLabels,
  useAvailableRenderServices,
  useConnectRender,
  useDisconnectRender,
  useRenderSettings,
  useSetRenderService,
  useStartDeploy,
} from '../../api/render';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const ENVIRONMENTS: DeployEnvironment[] = ['HOMOLOGACAO', 'PRODUCAO'];

/** Render account of the workspace and which service runs each project in each environment. */
export function RenderSection({ workspace }: { workspace: WorkspaceDetail }) {
  const settings = useRenderSettings(workspace.id);

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Deploy (Render)</h2>
      <p className="mt-1 text-xs text-muted">
        Os workflows fazem o merge do PR/MR do agente e disparam o deploy do serviço de homologação do projeto. A chave
        fica criptografada e nunca vai para os agentes.
      </p>
      <ErrorText error={settings.error} />
      {settings.data &&
        (settings.data.connection ? (
          <Connected workspace={workspace} ownerName={settings.data.connection.ownerName} apiKeyHint={settings.data.connection.apiKeyHint} />
        ) : (
          <ConnectForm workspaceId={workspace.id} />
        ))}
    </section>
  );
}

function ConnectForm({ workspaceId }: { workspaceId: string }) {
  const [apiKey, setApiKey] = useState('');
  const connect = useConnectRender(workspaceId);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate(apiKey.trim(), { onSuccess: () => setApiKey('') });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-3">
      <div className="min-w-72 flex-1">
        <Field label="Chave de API do Render" hint="Render → Account Settings → API Keys.">
          <TextInput type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" required />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={connect.isPending || !apiKey.trim()}>
        {connect.isPending ? 'Verificando...' : 'Conectar'}
      </Button>
      <div className="w-full">
        <ErrorText error={connect.error} />
      </div>
    </form>
  );
}

function Connected({ workspace, ownerName, apiKeyHint }: { workspace: WorkspaceDetail; ownerName: string; apiKeyHint: string }) {
  const settings = useRenderSettings(workspace.id);
  const available = useAvailableRenderServices(workspace.id, true);
  const setService = useSetRenderService(workspace.id);
  const deploy = useStartDeploy(workspace.id);
  const disconnect = useDisconnectRender(workspace.id);
  const projects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);

  const linked = (projectId: string, environment: DeployEnvironment) =>
    settings.data?.services.find((service) => service.projectId === projectId && service.environment === environment);

  return (
    <div className="mt-3 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="success">Conectado</Badge>
        <span>{ownerName}</span>
        <span className="font-mono text-xs text-muted">{apiKeyHint}</span>
        <Button
          size="sm"
          variant="danger"
          onClick={() => window.confirm('Desconectar o Render deste workspace?') && disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          Desconectar
        </Button>
      </div>
      <ErrorText error={available.error ?? setService.error ?? deploy.error ?? disconnect.error} />

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
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{project.name}</td>
                {ENVIRONMENTS.map((environment) => {
                  const current = linked(project.id, environment);
                  return (
                    <td key={environment} className="px-3 py-2">
                      <Select
                        value={current?.serviceId ?? ''}
                        onChange={(event) =>
                          setService.mutate({ projectId: project.id, environment, serviceId: event.target.value || null })
                        }
                        disabled={setService.isPending || !available.data}
                      >
                        <option value="">—</option>
                        {available.data?.map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.name}
                            {service.branch ? ` (${service.branch})` : ''}
                          </option>
                        ))}
                        {current && !available.data?.some((service) => service.id === current.serviceId) && (
                          <option value={current.serviceId}>{current.serviceName}</option>
                        )}
                      </Select>
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right">
                  {linked(project.id, 'HOMOLOGACAO') && (
                    <Button
                      size="sm"
                      onClick={() =>
                        window.confirm(`Disparar agora o deploy de homologação de ${project.name}?`) &&
                        deploy.mutate({ projectId: project.id, environment: 'HOMOLOGACAO' })
                      }
                      disabled={deploy.isPending}
                    >
                      Deploy homologação
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
