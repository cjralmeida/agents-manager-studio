import { useState } from 'react';
import type { Agent } from '../../api/agents';
import type { Board, BoardItem } from '../../api/boards';
import { sortItems } from './boardUtils';
import { ColorDot } from './OptionChip';
import { TaskCard } from './TaskCard';

interface KanbanViewProps {
  board: Board;
  items: BoardItem[];
  agents: Map<string, Agent>;
  onOpen: (item: BoardItem) => void;
  onMove: (item: BoardItem, columnId: string) => void;
}

const NO_STATUS = '__none__';

export function KanbanView({ board, items, agents, onOpen, onMove }: KanbanViewProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const blockedColumn = board.link.statusMap.blocked;
  const withoutStatus = items.filter((item) => !board.columns.some((column) => column.id === item.columnId));

  const columns = [
    ...(withoutStatus.length > 0
      ? [{ id: NO_STATUS, name: 'Sem status', color: '#8b93a7', description: 'Itens sem coluna definida.' }]
      : []),
    ...board.columns,
  ];

  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {columns.map((column) => {
        const columnItems =
          column.id === NO_STATUS ? withoutStatus : items.filter((item) => item.columnId === column.id);
        const canDrop = column.id !== NO_STATUS;

        return (
          <section
            key={column.id}
            onDragOver={(event) => {
              if (!canDrop) return;
              event.preventDefault();
              setDropTarget(column.id);
            }}
            onDragLeave={() => setDropTarget((current) => (current === column.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setDropTarget(null);
              const item = items.find((entry) => entry.id === event.dataTransfer.getData('text/plain'));
              if (canDrop && item && item.columnId !== column.id) onMove(item, column.id);
            }}
            className={`flex w-72 shrink-0 flex-col rounded-xl border bg-surface/60 transition-colors ${
              dropTarget === column.id ? 'border-accent bg-accent/5' : 'border-border'
            }`}
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2.5" title={column.description ?? undefined}>
              <ColorDot color={column.color} />
              <h3 className="truncate text-sm font-semibold">{column.name}</h3>
              <span className="rounded-full bg-border px-1.5 text-xs text-muted">{columnItems.length}</span>
              {column.id === blockedColumn && (
                <span className="ml-auto text-[11px] text-muted" title="Agentes não executam tarefas desta coluna">
                  sem agentes
                </span>
              )}
            </header>
            <div className="flex min-h-24 flex-col gap-2 p-2">
              {sortItems(board, columnItems, agents).map((item) => (
                <TaskCard key={item.id} board={board} item={item} agent={agents.get(item.id)} onOpen={() => onOpen(item)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
