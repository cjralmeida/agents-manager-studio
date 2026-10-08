import { useMemo, useState } from 'react';
import { useAgents } from '../../api/agents';
import { type Board, boardProviderLabels, useBoard, useBoardLink, useMoveTask, useRefreshBoard } from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';
import { BoardSetup } from './BoardSetup';
import { agentsByItem, matchesSearch } from './boardUtils';
import { KanbanView } from './KanbanView';
import { NewTaskForm } from './NewTaskForm';
import { TaskDrawer } from './TaskDrawer';
import { TaskTable } from './TaskTable';

export function BoardTab({ workspace }: { workspace: WorkspaceDetail }) {
  const link = useBoardLink(workspace.id);
  const board = useBoard(workspace.id, Boolean(link.data));

  if (link.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (link.error) return <ErrorText error={link.error} />;
  if (!link.data) return <BoardSetup workspace={workspace} />;
  if (board.error) return <ErrorText error={board.error} />;
  if (!board.data) return <p className="text-sm text-muted">Carregando o quadro de {link.data.title}...</p>;

  return <BoardView workspace={workspace} board={board.data} fetchedAt={board.dataUpdatedAt} />;
}

type View = 'board' | 'table';
const VIEW_KEY = 'ams.board.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'board';
  } catch {
    return 'board';
  }
}

function BoardView({ workspace, board, fetchedAt }: { workspace: WorkspaceDetail; board: Board; fetchedAt: number }) {
  const [view, setView] = useState<View>(readView);
  const [search, setSearch] = useState('');
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const agents = useAgents(workspace.id);
  const refresh = useRefreshBoard(workspace.id);
  const move = useMoveTask(workspace.id);

  const agentMap = useMemo(() => agentsByItem(agents.data ?? []), [agents.data]);
  const items = board.items.filter((item) => matchesSearch(item, search));
  const openItem = board.items.find((item) => item.id === openItemId);
  const waitingCount = board.items.filter((item) => agentMap.get(item.id)?.status === 'WAITING_INPUT').length;

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Preference only.
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="info">{boardProviderLabels[board.link.provider]}</Badge>
          <a href={board.url} target="_blank" rel="noreferrer" className="truncate font-semibold hover:text-accent">
            {board.title} ↗
          </a>
          {waitingCount > 0 && <Badge tone="warning">{waitingCount} aguardando você</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar tarefa, #número, @pessoa"
            className="w-60"
          />
          <div className="flex rounded-md border border-border p-0.5">
            {(['board', 'table'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => changeView(option)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${view === option ? 'bg-border text-white' : 'text-muted hover:text-white'}`}
              >
                {option === 'board' ? 'Quadro' : 'Tabela'}
              </button>
            ))}
          </div>
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending} title={`Atualizado ${timeAgo(new Date(fetchedAt).toISOString())}`}>
            {refresh.isPending ? 'Atualizando...' : 'Atualizar'}
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nova tarefa
          </Button>
        </div>
      </header>
      <ErrorText error={refresh.error ?? move.error} />

      {view === 'board' ? (
        <KanbanView
          board={board}
          items={items}
          agents={agentMap}
          onOpen={(item) => setOpenItemId(item.id)}
          onMove={(item, columnId) => move.mutate({ itemId: item.id, columnId })}
        />
      ) : (
        <TaskTable board={board} items={items} agents={agentMap} onOpen={(item) => setOpenItemId(item.id)} />
      )}

      {openItem && (
        <TaskDrawer
          workspace={workspace}
          board={board}
          item={openItem}
          agent={agentMap.get(openItem.id)}
          onClose={() => setOpenItemId(null)}
        />
      )}
      {creating && <NewTaskForm workspaceId={workspace.id} board={board} onClose={() => setCreating(false)} />}
    </div>
  );
}
