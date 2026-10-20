import { Link, useParams } from 'react-router';
import { Fragment, useEffect, useState } from 'react';
import { type GitProvider, type Project, type WorkspaceDetail, useSetProjectBaseBranch, useSetWorkspaceIgnored, useWorkspace } from '../api/workspaces';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { AgentProfilesTab } from '../components/agent-profiles/AgentProfilesTab';
import { BoardTab } from '../components/board/BoardTab';
import { Dashboard } from '../components/dashboard/Dashboard';
import { DeploysTab } from '../components/deploys/DeploysTab';
import { QualityTab } from '../components/quality/QualityTab';
import { RoadmapTab } from '../components/roadmap/RoadmapTab';
import { WorkflowsTab } from '../components/workflows/WorkflowsTab';
import { Tabs, useTabParam } from '../components/Tabs';
import { CloneRepositoryForm } from '../components/workspace/CloneRepositoryForm';
import { NewProjectForm } from '../components/workspace/NewProjectForm';
import { ProjectRunCell } from '../components/workspace/ProjectRunCell';
import { ProjectVariablesPanel } from '../components/workspace/ProjectVariablesPanel';
import { WorkspaceConnectorsTab } from '../components/workspace/WorkspaceConnectorsTab';
import { WorkspaceSettingsTab } from '../components/workspace/WorkspaceSettingsTab';

const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'board', label: 'Quadro de tarefas' },
  { id: 'agents', label: 'Agentes' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'quality', label: 'Defeitos' },
  { id: 'projects', label: 'Projetos' },
  { id: 'deploys', label: 'Deploys' },
  { id: 'connectors', label: 'Conectores' },
  { id: 'settings', label: 'Configuração' },
] as const;

const providerLabels: Record<GitProvider, string> = {
  GITHUB: 'GitHub',
  GITLAB: 'GitLab',
  OTHER: 'Outro',
};

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const workspace = useWorkspace(workspaceId);
  const setIgnored = useSetWorkspaceIgnored();
  const [activeTab, setActiveTab] = useTabParam(tabs);

  if (workspace.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (workspace.error) return <p className="text-sm text-red-300">{workspace.error.message}</p>;

  const { data } = workspace;

  return (
    <section>
      <Link to="/workspaces" className="text-sm text-muted hover:text-white">
        ← Workspaces
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{data.name}</h1>
            {data.isIgnored && <Badge>Ignorado</Badge>}
            {data.isMissing && <Badge tone="warning">Pasta não encontrada</Badge>}
          </div>
          <p className="mt-1 font-mono text-xs text-muted">{data.hostPath}</p>
        </div>
        {!data.isMissing && (
          <Button
            onClick={() => setIgnored.mutate({ id: data.id, isIgnored: !data.isIgnored })}
            disabled={setIgnored.isPending}
          >
            {data.isIgnored ? 'Deixar de ignorar' : 'Ignorar workspace'}
          </Button>
        )}
      </header>

      <div className="mt-6">
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>

      <div className="mt-6">
        {activeTab === 'board' && <BoardTab workspace={data} />}
        {activeTab === 'agents' && <AgentProfilesTab workspace={data} />}
        {activeTab === 'workflows' && <WorkflowsTab workspace={data} />}
        {activeTab === 'roadmap' && <RoadmapTab workspace={data} />}
        {activeTab === 'quality' && <QualityTab workspace={data} />}
        {activeTab === 'dashboard' && <Dashboard workspace={data} />}
        {activeTab === 'projects' && <ProjectsTab workspace={data} />}
        {activeTab === 'deploys' && <DeploysTab workspace={data} />}
        {activeTab === 'connectors' && <WorkspaceConnectorsTab workspace={data} />}
        {activeTab === 'settings' && <WorkspaceSettingsTab workspace={data} />}
      </div>
    </section>
  );
}

function ProjectsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const [form, setForm] = useState<'clone' | 'new' | null>(null);
  const close = () => setForm(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">Cada pasta do workspace é um projeto. Agentes só podem ser lançados em projetos com git.</p>
        {!form && (
          <div className="flex gap-2">
            <Button onClick={() => setForm('new')} disabled={workspace.isMissing}>
              Novo projeto
            </Button>
            <Button variant="primary" onClick={() => setForm('clone')} disabled={workspace.isMissing}>
              Clonar repositório
            </Button>
          </div>
        )}
      </div>
      {form === 'new' && <NewProjectForm workspaceId={workspace.id} onClose={close} />}
      {form === 'clone' && <CloneRepositoryForm workspaceId={workspace.id} onClose={close} />}
      <ProjectsTable workspaceId={workspace.id} projects={workspace.projects} />
    </div>
  );
}

/** Branch agents start from and open PRs/MRs into; empty follows the folder's current branch. */
function BaseBranchInput({ workspaceId, project }: { workspaceId: string; project: Project }) {
  const [value, setValue] = useState(project.baseBranch ?? '');
  const save = useSetProjectBaseBranch(workspaceId);
  useEffect(() => setValue(project.baseBranch ?? ''), [project.baseBranch]);
  const commit = () => {
    if (value.trim() !== (project.baseBranch ?? '')) save.mutate({ projectId: project.id, baseBranch: value.trim() || null });
  };
  return (
    <div>
      <label className="sr-only" htmlFor={`base-${project.id}`}>
        Branch base de {project.name}
      </label>
      <input
        id={`base-${project.id}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        placeholder="branch atual da pasta"
        title="Branch de onde os agentes partem e para onde abrem os PRs/MRs (ex.: a de homologação)"
        className="w-40 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        disabled={save.isPending}
      />
      {save.error && <p className="mt-1 max-w-xs text-xs text-red-300">{save.error.message}</p>}
    </div>
  );
}

function ProjectsTable({ workspaceId, projects }: { workspaceId: string; projects: Project[] }) {
  // The Rodar variables of one project open in a full-width row below it.
  const [variablesFor, setVariablesFor] = useState<string | null>(null);
  if (projects.length === 0) {
    return <p className="mt-4 text-sm text-muted">Nenhum projeto nesta pasta.</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-panel text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Projeto</th>
            <th className="px-4 py-2 font-medium">Repositório</th>
            <th className="px-4 py-2 font-medium">Branch base</th>
            <th className="px-4 py-2 font-medium">Situação</th>
            <th className="px-4 py-2 font-medium" title="Roda a última versão estável (instalou, compilou e passou nos testes) em http://projeto.localhost">
              Rodar
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <Fragment key={project.id}>
              <tr className={`border-t border-border ${project.isMissing ? 'opacity-60' : ''}`}>
              <td className="px-4 py-2">
                <div className="font-medium">{project.name}</div>
                <div className="font-mono text-xs text-muted">{project.hostPath}</div>
              </td>
              <td className="px-4 py-2">
                {project.gitProvider && (
                  <div className="flex items-center gap-2">
                    <Badge tone="info">{providerLabels[project.gitProvider]}</Badge>
                    <span className="truncate font-mono text-xs text-muted">{project.gitRemoteUrl}</span>
                  </div>
                )}
                {project.isGitRepo && !project.gitProvider && <span className="text-xs text-muted">Sem remote</span>}
              </td>
              <td className="px-4 py-2">{project.isGitRepo && !project.isMissing && <BaseBranchInput workspaceId={workspaceId} project={project} />}</td>
              <td className="px-4 py-2">
                {project.isMissing ? (
                  <Badge tone="warning">Pasta não encontrada</Badge>
                ) : project.isGitRepo ? (
                  <Badge tone="success">Pronto para agentes</Badge>
                ) : (
                  <Badge>Sem git</Badge>
                )}
              </td>
              <td className="px-4 py-2 align-top">
                <ProjectRunCell
                  project={project}
                  variablesOpen={variablesFor === project.id}
                  onToggleVariables={() => setVariablesFor((current) => (current === project.id ? null : project.id))}
                />
              </td>
              </tr>
              {variablesFor === project.id && (
                <tr>
                  <td colSpan={5} className="px-4 pb-3">
                    <ProjectVariablesPanel projectId={project.id} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
