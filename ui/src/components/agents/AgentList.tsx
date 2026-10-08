import { Link } from 'react-router';
import type { Agent } from '../../api/agents';
import type { ContainerUsage } from '../../api/system';
import { timeAgo } from '../../lib/time';
import { AgentStatusBadge } from './AgentStatusBadge';
import { AgentUsageLine } from './AgentUsage';

/** Simple table of agents; agents waiting for the user come first (ordered by the server). */
interface AgentListProps {
  agents: Agent[];
  showWorkspace?: boolean;
  /** Running containers by agent id, for the live memory/CPU. */
  live?: Map<string, ContainerUsage>;
}

export function AgentList({ agents, showWorkspace = false, live }: AgentListProps) {
  if (agents.length === 0) return <p className="text-sm text-muted">Nenhum agente ainda.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-panel text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Agente</th>
            {showWorkspace && <th className="px-4 py-2 font-medium">Workspace</th>}
            <th className="px-4 py-2 font-medium">Projeto</th>
            <th className="px-4 py-2 font-medium">Situação</th>
            <th className="px-4 py-2 font-medium">Consumo</th>
            <th className="px-4 py-2 font-medium">Atividade</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr
              key={agent.id}
              className={`border-t border-border hover:bg-border/30 ${agent.status === 'WAITING_INPUT' ? 'bg-amber-400/5' : ''}`}
            >
              <td className="px-4 py-2">
                <Link to={`/agents/${agent.id}`} className="font-medium hover:text-accent">
                  {agent.title}
                </Link>
                <div className="font-mono text-xs text-muted">{agent.branch}</div>
              </td>
              {showWorkspace && <td className="px-4 py-2">{agent.workspaceName}</td>}
              <td className="px-4 py-2">{agent.projectName}</td>
              <td className="px-4 py-2">
                <AgentStatusBadge status={agent.status} />
              </td>
              <td className="px-4 py-2">
                <AgentUsageLine agent={agent} live={live?.get(agent.id)} />
              </td>
              <td className="px-4 py-2 text-muted">{timeAgo(agent.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
