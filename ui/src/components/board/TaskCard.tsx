import type { Agent } from '../../api/agents';
import type { Board, BoardItem } from '../../api/boards';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { itemRef } from './boardUtils';
import { OptionChip } from './OptionChip';

interface TaskCardProps {
  board: Board;
  item: BoardItem;
  agent: Agent | undefined;
  onOpen: () => void;
}

export function TaskCard({ board, item, agent, onOpen }: TaskCardProps) {
  const waiting = agent?.status === 'WAITING_INPUT';
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
        waiting ? 'glow-question border-amber-400/70' : 'border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate font-mono">{itemRef(item)}</span>
        {item.pullRequests.length > 0 && <span title="Pull requests vinculados">PR ×{item.pullRequests.length}</span>}
      </div>
      <p className="mt-1 text-sm leading-snug font-medium">{item.title}</p>

      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {values.map(({ field, option }) => (
            <OptionChip key={field.id} option={option} title={`${field.name}: ${option.name}`} />
          ))}
        </div>
      )}

      {(agent || item.assignees.length > 0) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {agent ? <AgentStatusBadge status={agent.status} /> : <span />}
          <span className="truncate text-[11px] text-muted">{item.assignees.map((login) => `@${login}`).join(' ')}</span>
        </div>
      )}
    </button>
  );
}
