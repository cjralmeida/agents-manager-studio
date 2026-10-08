import { useHealth } from '../api/health';

function serverLabel(isPending: boolean, isError: boolean) {
  if (isPending) return '...';
  return isError ? 'indisponível' : 'online';
}

export function DashboardPage() {
  const health = useHealth();
  const database = health.data?.components.database;

  return (
    <section>
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-muted">Agentes em execução em todos os workspaces aparecerão aqui.</p>

      <div className="mt-6 w-72 rounded-lg border border-border bg-panel p-4">
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
      </div>
    </section>
  );
}
