import type { Agent } from '../../api/agents';
import { Badge } from '../Badge';

/** Outcome of an agent that delivers a result: status, summary, details and the tasks it created. */
export function AgentResultPanel({ agent }: { agent: Agent }) {
  const result = agent.result;
  if (!result || (!result.summary && !result.createdTasks?.length)) return null;

  return (
    <section className="mt-4 rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Resultado</h2>
        {result.status === 'failure' ? <Badge tone="danger">Falhou</Badge> : result.status === 'success' ? <Badge tone="success">Sucesso</Badge> : null}
      </div>
      {result.summary && <p className="mt-2 text-sm whitespace-pre-line text-gray-200">{result.summary}</p>}
      {result.details && <p className="mt-2 text-xs whitespace-pre-line text-muted">{result.details}</p>}
      {result.createdTasks && result.createdTasks.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Tarefas criadas ({result.createdTasks.length})</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {result.createdTasks.map((task) => (
              <li key={task.id}>
                {task.url ? (
                  <a href={task.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {task.title} ↗
                  </a>
                ) : (
                  task.title
                )}
                {task.ref && <span className="ml-2 font-mono text-xs text-muted">{task.ref.split('/').at(-1)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
