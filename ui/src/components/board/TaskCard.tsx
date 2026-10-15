import { useNavigate } from 'react-router';
import type { Agent } from '../../api/agents';
import type { BoardItem, BoardLayout } from '../../api/boards';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { itemRef } from './boardUtils';
import { OptionChip } from './OptionChip';

interface TaskCardProps {
  board: BoardLayout;
  item: BoardItem;
  agent: Agent | undefined;
  onOpen: () => void;
  label?: string | null;
  /** A workflow run is processing the task (any step, not only the one linked to it). */
  inWorkflow?: boolean;
}

/** A task that came back with a test report (homologation or play test) and is not done: a fix, picked before new work. */
function reworkOrigin(item: BoardItem, board: BoardLayout) {
  if (item.isClosed || (board.statusMap.done && item.columnId === board.statusMap.done)) return null;
  const match = /^#{2,3}\s*Relatório de (HOM|teste)\b/im.exec(item.body);
  return match ? (match[1] === 'HOM' ? 'HOM' : 'teste') : null;
}

export function TaskCard({ board, item, agent, onOpen, label, inWorkflow = false }: TaskCardProps) {
  const navigate = useNavigate();
  const waiting = agent?.status === 'WAITING_INPUT';
  const working = !agent?.paused && (inWorkflow || (agent !== undefined && ['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status)));
  const rework = reworkOrigin(item, board);
  const values = board.fields.flatMap((field) => {
    const option = field.options.find((entry) => entry.id === item.fields[field.id]);
    return option ? [{ field, option }] : [];
  });

  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className={`w-full cursor-grab rounded-lg border bg-panel p-3 text-left transition-colors hover:border-accent/60 active:cursor-grabbing ${
        waiting ? 'glow-question border-amber-400/70' : working ? 'glow-working' : 'border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate font-mono">
          {label && <span className="mr-1.5 font-sans font-medium text-accent">{label}</span>}
          {itemRef(item)}
        </span>
        {item.pullRequests.length > 0 && <span title="Pull requests vinculados">PR ×{item.pullRequests.length}</span>}
      </div>
      {rework && (
        <span
          className="mt-1.5 inline-block rounded border border-orange-400/50 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-200"
          title="Voltou com um relatório de teste: os agentes pegam correções antes de tarefas novas"
        >
          ↩ Correção · {rework}
        </span>
      )}
      <p className="mt-1 text-sm leading-snug font-medium">{item.title}</p>

      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {values.map(({ field, option }) => (
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
          className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
          title={agent.title}
        >
          <span className="truncate">O agente precisa de você</span>
          <span className="shrink-0 font-medium">Responder →</span>
        </span>
      )}

      {(agent || item.assignees.length > 0) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {agent ? <AgentStatusBadge status={agent.status} paused={agent.paused} /> : <span />}
          <span className="truncate text-[11px] text-muted">{item.assignees.map((login) => `@${login}`).join(' ')}</span>
        </div>
      )}
    </button>
  );
}
