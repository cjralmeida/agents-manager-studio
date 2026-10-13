import { useState } from 'react';
import { Link } from 'react-router';
import { type Agent, isWorking, useAgents } from '../api/agents';
import {
  type ScanSummary,
  type WorkspaceSummary,
  useDeleteWorkspace,
  useScanWorkspaces,
  useSetWorkspaceIgnored,
  useWorkspaces,
} from '../api/workspaces';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { NewWorkspaceForm } from '../components/workspace/NewWorkspaceForm';

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describeScan(summary: ScanSummary) {
  const { workspaces, projects } = summary;
  return [
    `Leitura concluída: ${plural(workspaces.total, 'workspace', 'workspaces')} e ${plural(projects.total, 'projeto', 'projetos')}.`,
    workspaces.added > 0 && plural(workspaces.added, 'workspace novo', 'workspaces novos'),
    projects.added > 0 && plural(projects.added, 'projeto novo', 'projetos novos'),
    workspaces.missing + projects.missing > 0 &&
      plural(workspaces.missing + projects.missing, 'pasta não encontrada', 'pastas não encontradas'),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function WorkspacesPage() {
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const workspaces = useWorkspaces(includeIgnored);
  const agents = useAgents();
  const scan = useScanWorkspaces();
  const [creating, setCreating] = useState(false);

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Workspaces</h1>
          <p className="mt-1 text-sm text-muted">Cada pasta da raiz de projetos vira um workspace.</p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={includeIgnored}
              onChange={(event) => setIncludeIgnored(event.target.checked)}
            />
            Mostrar ignorados
          </label>
          <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? 'Lendo...' : 'Reler diretório'}
          </Button>
          {!creating && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Novo workspace
            </Button>
          )}
        </div>
      </header>

      {creating && <NewWorkspaceForm onCancel={() => setCreating(false)} />}

      {scan.data && <p className="mt-4 text-sm text-emerald-300">{describeScan(scan.data)}</p>}
      {scan.error && <p className="mt-4 text-sm text-red-300">{scan.error.message}</p>}

      <div className="mt-6">
        {workspaces.isPending && <p className="text-sm text-muted">Carregando...</p>}
        {workspaces.error && <p className="text-sm text-red-300">{workspaces.error.message}</p>}
        {workspaces.data?.length === 0 && (
          <p className="text-sm text-muted">Nenhum workspace encontrado. Use “Reler diretório”.</p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-4">
          {workspaces.data?.map((workspace) => <WorkspaceCard key={workspace.id} workspace={workspace} activity={activityOf(agents.data, workspace.id)} />)}
        </div>
      </div>
    </section>
  );
}

/** How many of the workspace's executions are working or waiting for the user. */
function activityOf(agents: Agent[] | undefined, workspaceId: string) {
  const own = agents?.filter((agent) => agent.workspaceId === workspaceId) ?? [];
  return {
    working: own.filter(isWorking).length,
    waiting: own.filter((agent) => agent.status === 'WAITING_INPUT').length,
  };
}

function WorkspaceCard({ workspace, activity }: { workspace: WorkspaceSummary; activity: { working: number; waiting: number } }) {
  const setIgnored = useSetWorkspaceIgnored();
  const remove = useDeleteWorkspace();

  const handleRemove = () => {
    if (window.confirm(`Remover o workspace "${workspace.name}" do Studio?`)) {
      remove.mutate(workspace.id);
    }
  };

  return (
    <article
      className={`flex flex-col rounded-lg border bg-panel ${
        activity.waiting > 0 ? 'glow-question border-amber-400/70' : activity.working > 0 ? 'glow-working' : 'border-border'
      } ${workspace.isIgnored || workspace.isMissing ? 'opacity-60' : ''}`}
    >
      <Link to={`/workspaces/${workspace.id}`} className="flex-1 p-4 hover:bg-border/30">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">{workspace.name}</h2>
          {workspace.isIgnored && <Badge>Ignorado</Badge>}
          {workspace.isMissing && <Badge tone="warning">Pasta não encontrada</Badge>}
        </div>
        <p className="mt-1 truncate font-mono text-xs text-muted">{workspace.hostPath}</p>
        <p className="mt-3 text-sm text-muted">
          {plural(workspace.projectCount, 'projeto', 'projetos')} · {workspace.gitProjectCount} com git
        </p>
        {(activity.working > 0 || activity.waiting > 0) && (
          <p className="mt-1 text-xs">
            {activity.working > 0 && <span className="text-purple-300">{activity.working} trabalhando</span>}
            {activity.working > 0 && activity.waiting > 0 && <span className="text-muted"> · </span>}
            {activity.waiting > 0 && <span className="text-amber-300">{activity.waiting} aguardando você</span>}
          </p>
        )}
      </Link>
      <footer className="flex justify-end gap-2 border-t border-border px-4 py-2">
        {workspace.isMissing ? (
          <Button size="sm" variant="danger" onClick={handleRemove} disabled={remove.isPending}>
            Remover
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => setIgnored.mutate({ id: workspace.id, isIgnored: !workspace.isIgnored })}
            disabled={setIgnored.isPending}
          >
            {workspace.isIgnored ? 'Deixar de ignorar' : 'Ignorar'}
          </Button>
        )}
      </footer>
    </article>
  );
}
