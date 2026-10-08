import {
  type DeployEnvironment,
  environmentLabels,
  useAvailableRenderServices,
  useRenderSettings,
  useSetRenderService,
  useStartDeploy,
} from '../../api/render';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Select } from '../form';

const ENVIRONMENTS: DeployEnvironment[] = ['HOMOLOGACAO', 'PRODUCAO'];

/** Which Render service runs each project in each environment, with a manual deploy (needs the workspace's account). */
export function RenderSection({ workspace }: { workspace: WorkspaceDetail }) {
  const settings = useRenderSettings(workspace.id);
  const available = useAvailableRenderServices(workspace.id, Boolean(settings.data?.connection));
  const setService = useSetRenderService(workspace.id);
  const deploy = useStartDeploy(workspace.id);
  const projects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);

  const linked = (projectId: string, environment: DeployEnvironment) =>
    settings.data?.services.find((service) => service.projectId === projectId && service.environment === environment);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Os workflows fazem o merge do PR/MR do agente e disparam o deploy do serviço de homologação do projeto.
      </p>
      <ErrorText error={settings.error ?? available.error ?? setService.error ?? deploy.error} />
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
