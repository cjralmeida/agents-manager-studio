import { type ReactNode, useState } from 'react';
import { useAgents } from '../../api/agents';
import { useHealth } from '../../api/health';
import type { WorkspaceDetail } from '../../api/workspaces';
import { AgentsView } from '../agents/AgentsView';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { DeploymentsPanel } from '../render/DeploymentsPanel';
import { ResourcePanel } from '../system/ResourcePanel';
import { ClaudeUsagePanel } from '../usage/ClaudeUsagePanel';

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
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 space-y-4">
        {workspace && creating && <NewAgentForm workspaceId={workspace.id} projects={workspace.projects} onCancel={() => setCreating(false)} />}
        <ErrorText error={agents.error} />
        {agents.data && (
          <AgentsView
            agents={agents.data}
            viewKey={workspace ? 'workspace-agents' : 'dashboard-agents'}
            showWorkspace={!workspace}
            title={<h2 className="text-sm font-medium">{workspace ? 'Agentes do workspace' : 'Agentes de todos os workspaces'}</h2>}
            actions={
              workspace &&
              !creating && (
                <Button variant="primary" onClick={() => setCreating(true)} disabled={workspace.isMissing}>
                  Novo agente
                </Button>
              )
            }
          />
        )}
      </div>

      <aside className="w-full shrink-0 space-y-4 xl:w-80">
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
