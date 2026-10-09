import {
  type DeployEnvironment,
  environmentLabels,
  useAvailableRenderServices,
  useRenderSettings,
  useSetRenderService,
  useStartDeploy,
} from "../../api/render";
import { useState } from "react";
import type { WorkspaceDetail } from "../../api/workspaces";
import { Button } from "../Button";
import { ErrorText, Select } from "../form";

const ENVIRONMENTS: DeployEnvironment[] = ["HOMOLOGACAO", "PRODUCAO"];

/**
 * Which Render service runs each project in each environment, with a manual deploy (needs the workspace's account).
 * Collapsed by default: a workspace has many projects and only a few services, so it shows a summary first.
 */
export function RenderSection({ workspace }: { workspace: WorkspaceDetail }) {
  const [open, setOpen] = useState(false);
  const settings = useRenderSettings(workspace.id);
  // The services the account sees are only needed to edit (one Render call fewer when collapsed).
  const available = useAvailableRenderServices(
    workspace.id,
    Boolean(settings.data?.connection) && open,
  );
  const setService = useSetRenderService(workspace.id);
  const deploy = useStartDeploy(workspace.id);
  const projects = workspace.projects.filter(
    (project) => project.isGitRepo && !project.isMissing,
  );

  const linked = (projectId: string, environment: DeployEnvironment) =>
    settings.data?.services.find(
      (service) =>
        service.projectId === projectId && service.environment === environment,
    );

  const services = settings.data?.services ?? [];
  const projectName = (projectId: string) =>
    workspace.projects.find((project) => project.id === projectId)?.name ?? "?";
  const summary = services
    .slice()
    .sort((a, b) =>
      projectName(a.projectId).localeCompare(projectName(b.projectId)),
    )
    .map(
      (service) =>
        `${projectName(service.projectId)} → ${service.serviceName}${service.branch ? ` (${service.branch})` : ""}${service.environment === "PRODUCAO" ? " [produção]" : ""}`,
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted">
          {services.length === 0
            ? "Nenhum projeto com serviço do Render ainda."
            : `${services.length} serviço${services.length === 1 ? "" : "s"}: ${summary.join(" · ")}`}
        </p>
        <Button
          size="sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? "Ocultar serviços" : "Configurar serviços"}
        </Button>
      </div>
      <ErrorText error={settings.error ?? setService.error ?? deploy.error} />
      {open && (
        <>
          <p className="text-xs text-muted">
            Os workflows fazem o merge do PR/MR do agente e disparam o deploy do
            serviço de homologação do projeto.
          </p>
          <ErrorText error={available.error} />
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
                            value={current?.serviceId ?? ""}
                            onChange={(event) =>
                              setService.mutate({
                                projectId: project.id,
                                environment,
                                serviceId: event.target.value || null,
                              })
                            }
                            disabled={setService.isPending || !available.data}
                          >
                            <option value="">—</option>
                            {available.data?.map((service) => (
                              <option key={service.id} value={service.id}>
                                {service.name}
                                {service.branch ? ` (${service.branch})` : ""}
                              </option>
                            ))}
                            {current &&
                              !available.data?.some(
                                (service) => service.id === current.serviceId,
                              ) && (
                                <option value={current.serviceId}>
                                  {current.serviceName}
                                </option>
                              )}
                          </Select>
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">
                      {linked(project.id, "HOMOLOGACAO") && (
                        <Button
                          size="sm"
                          onClick={() =>
                            window.confirm(
                              `Disparar agora o deploy de homologação de ${project.name}?`,
                            ) &&
                            deploy.mutate({
                              projectId: project.id,
                              environment: "HOMOLOGACAO",
                            })
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
        </>
      )}
    </div>
  );
}
