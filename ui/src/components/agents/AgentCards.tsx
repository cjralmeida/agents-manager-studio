import { Link } from 'react-router';
import type { Agent } from '../../api/agents';
import { timeAgo } from '../../lib/time';
import { AgentStatusBadge } from './AgentStatusBadge';

/** Agent cards; the server already puts agents waiting for the user first, and those cards glow. */
export function AgentCards({ agents, showWorkspace = false }: { agents: Agent[]; showWorkspace?: boolean }) {
  if (agents.length === 0) return <p className="text-sm text-muted">Nenhum agente ainda.</p>;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} showWorkspace={showWorkspace} />
      ))}
    </div>
  );
}

function AgentCard({ agent, showWorkspace }: { agent: Agent; showWorkspace: boolean }) {
  const waiting = agent.status === 'WAITING_INPUT';
  const question = agent.pendingQuestion?.[0];

  return (
    <Link
      to={`/agents/${agent.id}`}
      className={`flex flex-col rounded-lg border bg-panel p-4 transition-colors hover:border-accent/60 ${
        waiting ? 'glow-question border-amber-400/70' : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm leading-snug font-semibold">{agent.title}</h3>
        <AgentStatusBadge status={agent.status} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {showWorkspace && agent.workspaceName ? `${agent.workspaceName} · ` : ''}
        {agent.projectName}
        {agent.taskRef ? ` · ${agent.taskRef.split('/').at(-1)}` : ''}
      </p>

      {question && (
        <p className="mt-3 line-clamp-2 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200">
          {question.question}
        </p>
      )}
      {agent.status === 'FAILED' && agent.errorMessage && (
        <p className="mt-3 line-clamp-2 text-xs text-red-300">{agent.errorMessage}</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-muted">
        <span className="truncate font-mono">{agent.branch}</span>
        <span className="shrink-0">
          {agent.model} · {timeAgo(agent.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
}
