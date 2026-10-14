import { type ReactNode, useState } from 'react';
import { type AgentProfile, useAgentProfiles, useAllAgentProfiles } from '../../api/agentProfiles';
import { useAgents } from '../../api/agents';
import { useHealth } from '../../api/health';
import type { WorkspaceDetail } from '../../api/workspaces';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { DeploymentsPanel } from '../render/DeploymentsPanel';
import { ResourcePanel } from '../system/ResourcePanel';
import { ClaudeUsagePanel } from '../usage/ClaudeUsagePanel';
import { Tabs } from '../Tabs';
import { ActiveWorkflows, useActiveWorkflowRuns } from './ActiveWorkflows';
import { AgentsOverview } from './AgentsOverview';
import { StuckTasks } from './StuckTasks';

type DashboardTab = 'agents' | 'workflows';

/** The chosen tab is a per-viewer convenience, remembered per dashboard. */
function useDashboardTab(key: string) {
  const [tab, setTab] = useState<DashboardTab>(() => {
    try {
      return localStorage.getItem(key) === 'workflows' ? 'workflows' : 'agents';
    } catch {
      return 'agents';
    }
  });
  const change = (next: DashboardTab) => {
    setTab(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Preference only.
    }
  };
  return [tab, change] as const;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * The general dashboard, or the same dashboard restricted to one workspace: its agents,
 * the Claude usage of those agents and the Docker resources they use.
 */
export function Dashboard({ workspace }: { workspace?: WorkspaceDetail }) {
  const agents = useAgents(workspace?.id);
  // The workspace dashboard lists its own agents; the general one, every workspace's.
  const workspaceProfiles = useAgentProfiles(workspace?.id ?? '', Boolean(workspace));
  const allProfiles = useAllAgentProfiles(!workspace);
  const profiles = workspace ? workspaceProfiles : allProfiles;
  /** Launch form: a workspace agent, an ad hoc agent ("avulso") or closed. */
  const [launching, setLaunching] = useState<AgentProfile | 'avulso' | null>(null);
  const [tab, setTab] = useDashboardTab(workspace ? 'ams.dashboard.workspace.tab' : 'ams.dashboard.tab');
  const activeRuns = useActiveWorkflowRuns(workspace?.id);
  const tabs = [
    { id: 'agents' as const, label: 'Agentes' },
    { id: 'workflows' as const, label: activeRuns.runs.length > 0 ? `Workflows · ${activeRuns.runs.length} ativo${activeRuns.runs.length === 1 ? '' : 's'}` : 'Workflows' },
  ];

  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 space-y-4">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        {tab === 'workflows' && <ActiveWorkflows workspaceId={workspace?.id} />}
        {tab === 'agents' && workspace && launching && (
          <NewAgentForm
            key={launching === 'avulso' ? 'avulso' : launching.id}
            workspaceId={workspace.id}
            projects={workspace.projects}
            initial={launching === 'avulso' ? undefined : { profileId: launching.id }}
            onCancel={() => setLaunching(null)}
          />
        )}
        {tab === 'agents' && <ErrorText error={agents.error ?? profiles.error} />}
        {tab === 'agents' && agents.data && profiles.data && (
          <AgentsOverview
            profiles={profiles.data}
            executions={agents.data}
            viewKey={workspace ? 'workspace-agents' : 'dashboard-agents'}
            showWorkspace={!workspace}
            title={<h2 className="text-sm font-medium">{workspace ? 'Agentes do workspace' : 'Agentes de todos os workspaces'}</h2>}
            onRun={workspace && !workspace.isMissing ? (profile) => setLaunching(profile) : undefined}
            actions={
              workspace &&
              !launching && (
                <Button onClick={() => setLaunching('avulso')} disabled={workspace.isMissing} title="Agente sem papel fixo, só com a tarefa">
                  Agente avulso
                </Button>
              )
            }
          />
        )}
      </div>

      <aside className="w-full shrink-0 space-y-4 xl:w-80">
        <StuckTasks workspaceId={workspace?.id} />
        <Panel title="Consumo do Claude">
          <ClaudeUsagePanel workspaceId={workspace?.id} />
        </Panel>
        <Panel title={workspace ? 'Recursos dos agentes no Docker' : 'Consumo do Studio no Docker'}>
          <ResourcePanel workspaceId={workspace?.id} />
        </Panel>
        {workspace && (
          <Panel title="Deploys">
            <DeploymentsPanel workspaceId={workspace.id} />
          </Panel>
        )}
        {!workspace && <SystemStatus />}
      </aside>
    </div>
  );
}

function SystemStatus() {
  const health = useHealth();
  const database = health.data?.components.database;
  const server = health.isPending ? '...' : health.isError ? 'indisponível' : 'online';

  return (
    <Panel title="Status do sistema">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Server</dt>
          <dd>{server}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Banco de dados</dt>
          <dd>{database === undefined ? '...' : database === 'up' ? 'online' : 'indisponível'}</dd>
        </div>
      </dl>
    </Panel>
  );
}
