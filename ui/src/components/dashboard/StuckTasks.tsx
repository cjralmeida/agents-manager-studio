import { Link } from 'react-router';
import { useStuckTasks } from '../../api/boards';
import { ErrorText } from '../form';

/**
 * Tasks the board watch found stuck (no agent, no run, no reason to wait), with why and what it did about them.
 * Shown only when there are some.
 */
export function StuckTasks({ workspaceId }: { workspaceId?: string }) {
  const stuck = useStuckTasks();
  const tasks = (stuck.data ?? []).filter((task) => !workspaceId || task.workspaceId === workspaceId);
  if (stuck.error) return <ErrorText error={stuck.error} />;
  if (tasks.length === 0) return null;

  return (
    <section className="rounded-lg border border-amber-500/40 bg-panel p-4">
      <h2 className="text-sm font-medium">Tarefas paradas · {tasks.length}</h2>
      <p className="mt-1 text-xs text-muted">O vigia do quadro achou estas tarefas sem agente, sem execução e sem motivo para esperar.</p>
      <ul className="mt-3 space-y-3">
        {tasks.map((task) => (
          <li key={task.itemId} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              {task.url ? (
                <a href={task.url} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline" title={task.title}>
                  {task.title}
                </a>
              ) : (
                <span className="truncate font-medium" title={task.title}>
                  {task.title}
                </span>
              )}
              <span className="shrink-0 text-muted">{task.column}</span>
            </div>
            {!workspaceId && <p className="text-muted">{task.workspaceName}</p>}
            <p className="mt-1 text-muted">{task.reason}</p>
            {task.action && (
              <p className="mt-1">
                {task.action}{' '}
                {task.agentId && (
                  <Link to={`/agents/${task.agentId}`} className="text-accent hover:underline">
                    Abrir →
                  </Link>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
