import type { Agent } from '../../api/agents';
import type { Board, BoardItem } from '../../api/boards';
import { timeAgo } from '../../lib/time';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { itemRef, sortItems } from './boardUtils';
import { OptionChip } from './OptionChip';

interface TaskTableProps {
  board: Board;
  items: BoardItem[];
  agents: Map<string, Agent>;
  onOpen: (item: BoardItem) => void;
}

/** Same tasks as the board, one row each, grouped by column order. */
export function TaskTable({ board, items, agents, onOpen }: TaskTableProps) {
  if (items.length === 0) return <p className="text-sm text-muted">Nenhuma tarefa.</p>;

  // Items without a column (-1) come first, like the "Sem status" column of the board.
  const columnIndex = (item: BoardItem) => board.columns.findIndex((column) => column.id === item.columnId);
  const rows = sortItems(board, items, agents).sort((a, b) => columnIndex(a) - columnIndex(b));

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-panel text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Tarefa</th>
            <th className="px-3 py-2 font-medium">Status</th>
            {board.fields.map((field) => (
              <th key={field.id} className="px-3 py-2 font-medium">
                {field.name}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Agente</th>
            <th className="px-3 py-2 font-medium">Atualizada</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const column = board.columns.find((entry) => entry.id === item.columnId);
            const agent = agents.get(item.id);
            return (
              <tr
                key={item.id}
                onClick={() => onOpen(item)}
                className={`cursor-pointer border-t border-border hover:bg-border/30 ${
                  agent?.status === 'WAITING_INPUT' ? 'bg-amber-400/5' : ''
                }`}
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{item.title}</div>
                  <div className="font-mono text-xs text-muted">{itemRef(item)}</div>
                </td>
                <td className="px-3 py-2">{column ? <OptionChip option={column} /> : <span className="text-muted">—</span>}</td>
                {board.fields.map((field) => {
                  const option = field.options.find((entry) => entry.id === item.fields[field.id]);
                  return (
                    <td key={field.id} className="px-3 py-2">
                      {option ? <OptionChip option={option} /> : <span className="text-muted">—</span>}
                    </td>
                  );
                })}
                <td className="px-3 py-2">{agent ? <AgentStatusBadge status={agent.status} /> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">{timeAgo(item.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
