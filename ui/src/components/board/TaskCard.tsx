import { useNavigate } from 'react-router';
import type { Agent } from '../../api/agents';
import type { BoardItem, BoardLayout } from '../../api/boards';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { itemRef, reworkOrigin } from './boardUtils';
import { OptionChip } from './OptionChip';
import { AvatarStack, PriorityFlag } from './taskVisuals';

interface TaskCardProps {
  board: BoardLayout;
  item: BoardItem;
  agent: Agent | undefined;
  onOpen: () => void;
  label?: string | null;
  /** A workflow run is processing the task (any step, not only the one linked to it). */
  inWorkflow?: boolean;
}

export function TaskCard({ board, item, agent, onOpen, label, inWorkflow = false }: TaskCardProps) {
  const navigate = useNavigate();
  const waiting = agent?.status === 'WAITING_INPUT';
  const working = !agent?.paused && (inWorkflow || (agent !== undefined && ['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status)));
  const rework = reworkOrigin(item, board.statusMap);

  const values = board.fields.flatMap((field) => {
    const option = field.options.find((entry) => entry.id === item.fields[field.id]);
    return option ? [{ field, option }] : [];
  });
  const priority = values.find(({ field }) => /priorid|priority/i.test(field.name));
  const chips = values.filter((entry) => entry !== priority);
  const accentColor = priority?.option.color;

  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className={`group relative w-full cursor-grab overflow-hidden rounded-xl border bg-panel py-3 pr-3 pl-4 text-left shadow-sm transition-all hover:-translate-y-px hover:border-accent/60 hover:shadow-md active:cursor-grabbing ${
        waiting ? 'glow-question border-amber-400/70' : working ? 'glow-working' : 'border-border'
      }`}
    >
      {/* Left accent bar, colored by priority */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1" style={{ backgroundColor: accentColor ?? 'var(--color-accent)', opacity: accentColor ? 0.9 : 0.35 }} />

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate font-mono">
          {label && <span className="mr-1.5 font-sans font-medium text-accent">{label}</span>}
          {itemRef(item)}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {priority && <PriorityFlag option={priority.option} />}
          {item.pullRequests.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-border px-1.5 py-0.5 font-medium text-muted" title="Pull requests vinculados">
              <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true">
                <path d="M4.5 2a2 2 0 0 0-.75 3.85v4.3a2 2 0 1 0 1.5 0V8.6c.4.26.87.4 1.37.4H9.1a2 2 0 0 0 1.9-1.37A2 2 0 1 0 9.6 5.1 2 2 0 0 0 7.87 6.5H6.62c-.3 0-.6-.09-.87-.25V5.85A2 2 0 0 0 4.5 2Z" />
              </svg>
              {item.pullRequests.length}
            </span>
          )}
        </div>
      </div>

      {rework && (
        <span
          className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-orange-400/50 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-200"
          title="Voltou com um relatório de teste: os agentes pegam correções antes de tarefas novas"
        >
          ↩ Correção · {rework}
        </span>
      )}

      <p className="mt-1.5 text-sm leading-snug font-medium text-fg">{item.title}</p>

      {chips.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {chips.map(({ field, option }) => (
            <OptionChip key={field.id} option={option} title={`${field.name}: ${option.name}`} />
          ))}
        </div>
      )}

      {waiting && agent && (
        // Inside the card's button: a span acting as a link, so a click answers instead of opening the task.
        <span
          role="link"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/agents/${agent.id}#pergunta`);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.stopPropagation();
            navigate(`/agents/${agent.id}#pergunta`);
          }}
          className="mt-2.5 flex items-center justify-between gap-2 rounded-lg border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20"
          title={agent.title}
        >
          <span className="truncate">O agente precisa de você</span>
          <span className="shrink-0">Responder →</span>
        </span>
      )}

      {(agent || item.assignees.length > 0) && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
          {item.assignees.length > 0 ? <AvatarStack logins={item.assignees} /> : <span />}
          {agent ? <AgentStatusBadge status={agent.status} paused={agent.paused} /> : <span />}
        </div>
      )}
    </button>
  );
}
