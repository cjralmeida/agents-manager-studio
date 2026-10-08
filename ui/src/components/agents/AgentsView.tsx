import type { ReactNode } from 'react';
import type { Agent } from '../../api/agents';
import { ViewToggle, usePersistedView } from '../ViewToggle';
import { AgentCards } from './AgentCards';
import { AgentList } from './AgentList';

interface AgentsViewProps {
  agents: Agent[];
  /** Remembers the card/table choice separately per screen. */
  viewKey: string;
  showWorkspace?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
}

/** Agents as cards or table, with a header showing how many wait for the user. */
export function AgentsView({ agents, viewKey, showWorkspace = false, title, actions }: AgentsViewProps) {
  const [view, setView] = usePersistedView(viewKey);
  const waiting = agents.filter((agent) => agent.status === 'WAITING_INPUT').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {title}
          {waiting > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300">
              {waiting} aguardando você
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>
      {view === 'cards' ? (
        <AgentCards agents={agents} showWorkspace={showWorkspace} />
      ) : (
        <AgentList agents={agents} showWorkspace={showWorkspace} />
      )}
    </div>
  );
}
