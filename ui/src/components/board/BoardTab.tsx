import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgents } from '../../api/agents';
import { type Board, boardProviderLabels, useBoard, useBoardLink, useMoveTask, useRefreshBoard } from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';
import { ViewToggle, usePersistedView } from '../ViewToggle';
import { BoardSetup } from './BoardSetup';
import { BoardConversionPanel } from './BoardConversionPanel';
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

  return <BoardView workspace={workspace} board={board.data} />;
}

/** "Lido há 1 min · automático a cada 2 min", or the last sync error. */
function SyncStatus({ board }: { board: Board }) {
  const { lastSyncedAt, lastSyncError, refreshIntervalSec } = board.link;
  if (lastSyncError) {
    return (
      <span className="text-xs text-red-300" title={lastSyncError}>
        Falha ao atualizar o quadro
      </span>
    );
  }
  return (
    <span className="text-xs text-muted">
      {lastSyncedAt ? `Lido ${timeAgo(lastSyncedAt)}` : 'Ainda não lido'} · automático a cada {Math.round(refreshIntervalSec / 60)} min
    </span>
  );
}

function BoardView({ workspace, board }: { workspace: WorkspaceDetail; board: Board }) {
  const [view, setView] = usePersistedView('board');
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  // The board of all workspaces links here with ?task=<id> to open that task.
  const [openItemId, setOpenItemIdState] = useState<string | null>(params.get('task'));
  const setOpenItemId = (id: string | null) => {
    setOpenItemIdState(id);
    if (!id && params.has('task')) {
      params.delete('task');
      setParams(params, { replace: true });
    }
  };
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState(false);
  const agents = useAgents(workspace.id);
  const refresh = useRefreshBoard(workspace.id);
  const move = useMoveTask(workspace.id);

  const agentMap = useMemo(() => agentsByItem(agents.data ?? []), [agents.data]);
  const items = board.items.filter((item) => matchesSearch(item, search));
  const openItem = board.items.find((item) => item.id === openItemId);
  const waitingCount = board.items.filter((item) => agentMap.get(item.id)?.status === 'WAITING_INPUT').length;

  if (converting) return <BoardConversionPanel workspaceId={workspace.id} onClose={() => setConverting(false)} />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="info">{boardProviderLabels[board.link.provider]}</Badge>
          {board.link.provider === 'STUDIO' ? (
            <span className="truncate font-semibold">{board.title}</span>
          ) : (
            <a href={board.url} target="_blank" rel="noreferrer" className="truncate font-semibold hover:text-accent">
              {board.title} ↗
            </a>
          )}
          {waitingCount > 0 && <Badge tone="warning">{waitingCount} aguardando você</Badge>}
          <SyncStatus board={board} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar tarefa, #número, @pessoa"
            className="w-60"
          />
          <ViewToggle view={view} onChange={setView} cardsLabel="Quadro" />
          <Link to="/board?tab=model" className="text-xs text-muted hover:text-accent" title="Colunas e campos valem para todos os workspaces">
            Modelo do quadro
          </Link>
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Lê o quadro do provedor agora">
            {refresh.isPending ? 'Atualizando...' : 'Atualizar'}
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nova tarefa
          </Button>
        </div>
      </header>
      <ErrorText error={refresh.error ?? move.error} />
      {board.link.modelStatus !== 'synced' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <span className="text-amber-200">
            {board.link.modelStatus === 'pending'
              ? 'Este quadro ainda não segue o modelo do Studio.'
              : 'Este quadro foi alterado fora do Studio e não está mais igual ao modelo.'}
            {board.link.modelSyncError && <span className="ml-1 text-xs text-red-300">({board.link.modelSyncError})</span>}
          </span>
          <Button size="sm" variant="primary" onClick={() => setConverting(true)}>
            {board.link.modelStatus === 'pending' ? 'Converter para o modelo' : 'Sincronizar com o modelo'}
          </Button>
        </div>
      )}

      {view === 'cards' ? (
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
