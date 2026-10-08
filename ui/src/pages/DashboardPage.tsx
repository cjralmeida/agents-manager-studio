import { useAgents } from '../api/agents';
import { useHealth } from '../api/health';
import { AgentsView } from '../components/agents/AgentsView';
import { ErrorText } from '../components/form';
import { ResourcePanel } from '../components/system/ResourcePanel';

function serverLabel(isPending: boolean, isError: boolean) {
  if (isPending) return '...';
  return isError ? 'indisponível' : 'online';
}

export function DashboardPage() {
  const health = useHealth();
  const agents = useAgents();
  const database = health.data?.components.database;

  return (
    <section>
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="mt-6 flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <ErrorText error={agents.error} />
          {agents.data && (
            <AgentsView
              agents={agents.data}
              viewKey="dashboard-agents"
              showWorkspace
              title={<h2 className="text-sm font-medium">Agentes de todos os workspaces</h2>}
            />
          )}
        </div>

        <aside className="w-full shrink-0 space-y-4 xl:w-80">
          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="text-sm font-medium">Consumo do Docker</h2>
            <div className="mt-3">
              <ResourcePanel />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-panel p-4">
            <h2 className="text-sm font-medium">Status do sistema</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Server</dt>
                <dd>{serverLabel(health.isPending, health.isError)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Banco de dados</dt>
                <dd>{database === undefined ? '...' : database === 'up' ? 'online' : 'indisponível'}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );
}
