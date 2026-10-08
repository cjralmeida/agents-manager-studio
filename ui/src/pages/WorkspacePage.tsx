import { Link, useParams } from 'react-router';
import { type GitProvider, type Project, useSetWorkspaceIgnored, useWorkspace } from '../api/workspaces';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { BoardTab } from '../components/board/BoardTab';
import { Tabs, useTabParam } from '../components/Tabs';
import { WorkspaceAgentsTab } from '../components/workspace/WorkspaceAgentsTab';
import { WorkspaceSettingsTab } from '../components/workspace/WorkspaceSettingsTab';

const tabs = [
  { id: 'board', label: 'Quadro' },
  { id: 'agents', label: 'Agentes' },
  { id: 'projects', label: 'Projetos' },
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
        {activeTab === 'agents' && <WorkspaceAgentsTab workspace={data} />}
        {activeTab === 'projects' && (
          <>
            <p className="text-xs text-muted">Agentes só podem ser lançados em projetos com git.</p>
            <ProjectsTable projects={data.projects} />
          </>
        )}
        {activeTab === 'settings' && <WorkspaceSettingsTab workspace={data} />}
      </div>
    </section>
  );
}

function ProjectsTable({ projects }: { projects: Project[] }) {
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
            <th className="px-4 py-2 font-medium">Situação</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} className={`border-t border-border ${project.isMissing ? 'opacity-60' : ''}`}>
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
              <td className="px-4 py-2">
                {project.isMissing ? (
                  <Badge tone="warning">Pasta não encontrada</Badge>
                ) : project.isGitRepo ? (
                  <Badge tone="success">Pronto para agentes</Badge>
                ) : (
                  <Badge>Sem git</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
