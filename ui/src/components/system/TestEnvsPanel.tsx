import { Link } from 'react-router';
import { useStopTestEnv, useTestEnvs } from '../../api/testEnvs';
import { ErrorText } from '../form';

const statusLabel = { queued: 'na fila', building: 'subindo', ready: 'no ar', failed: 'falhou', stopped: 'derrubado' } as const;

/** Local test environments (a project's test stack in Docker) and how many more fit on the computer. */
export function TestEnvsPanel() {
  const envs = useTestEnvs();
  const stop = useStopTestEnv();
  if (envs.error) return <ErrorText error={envs.error} />;
  if (!envs.data) return null;
  const { environments, capacity } = envs.data;

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Ambientes de teste</h3>
      <p className="text-xs text-muted">
        {capacity.active} no ar · cabem mais {capacity.fits} agora (~{Math.round(capacity.memoryMbPerEnv / 1024 * 10) / 10} GB cada, memória até{' '}
        {capacity.limitPercent}%)
      </p>
      {environments.map((env) => (
        <div key={env.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">
            {env.project} · {statusLabel[env.status]}
            {env.agentId && (
              <Link to={`/agents/${env.agentId}`} className="ml-1 text-muted hover:text-accent">
                agente →
              </Link>
            )}
          </span>
          <button type="button" className="shrink-0 text-muted hover:text-red-300" disabled={stop.isPending} onClick={() => stop.mutate(env.id)}>
            Derrubar
          </button>
        </div>
      ))}
    </div>
  );
}
