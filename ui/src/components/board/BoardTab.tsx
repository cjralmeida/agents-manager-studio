import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgents } from '../../api/agents';
import { useInActiveWorkflow } from '../../api/workflows';
import { type Board, type BoardSource, boardProviderLabels, useBoard, useBoardSources, useMoveTask, useRefreshBoard } from '../../api/boards';
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
  const sources = useBoardSources(workspace.id);
  const hasBoard = (sources.data?.length ?? 0) > 0;
  const board = useBoard(workspace.id, hasBoard);

  if (sources.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (sources.error) return <ErrorText error={sources.error} />;
  if (!hasBoard) return <BoardSetup workspace={workspace} />;
  if (board.error) return <ErrorText error={board.error} />;
  if (!board.data) return <p className="text-sm text-muted">Carregando o quadro...</p>;

  return <BoardView workspace={workspace} board={board.data} />;
}

/** "Lido há 1 min · automático a cada 2 min" for the oldest read, or which board failed. */
function SyncStatus({ sources }: { sources: BoardSource[] }) {
  const failed = sources.filter((source) => source.lastSyncError);
  if (failed.length > 0) {
    return (
      <span className="text-xs text-red-300" title={failed.map((source) => `${source.title}: ${source.lastSyncError}`).join('\n')}>
        Falha ao atualizar {failed.length === 1 ? `"${failed[0]!.title}"` : `${failed.length} quadros`}
      </span>
    );
  }
  const reads = sources.map((source) => source.lastSyncedAt).filter((at): at is string => Boolean(at)).sort();
  const interval = Math.round((sources[0]?.refreshIntervalSec ?? 120) / 60);
  return (
    <span className="text-xs text-muted">
      {reads.length < sources.length ? 'Ainda não lido' : `Lido ${timeAgo(reads[0]!)}`} · automático a cada {interval} min
    </span>
  );
}

/** A board joined on the workspace board: where it lives, linking out to it. */
function SourceChip({ source }: { source: BoardSource }) {
  const label = boardProviderLabels[source.provider];
  return source.provider === 'STUDIO' ? (
    <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs">
      <span className="font-medium text-muted">{label}</span>
      <span className="truncate">{source.title}</span>
    </span>
  ) : (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs hover:border-accent hover:text-accent"
      title={`${source.title} (${source.ownerPath})`}
    >
      <span className="font-medium text-muted">{label}</span>
      <span className="truncate">{source.title} ↗</span>
    </a>
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
  const [adding, setAdding] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const agents = useAgents(workspace.id);
  const refresh = useRefreshBoard(workspace.id);
  const move = useMoveTask(workspace.id);

  const agentMap = useMemo(() => agentsByItem(agents.data ?? []), [agents.data]);
  const inActiveWorkflow = useInActiveWorkflow();
  const inWorkflow = (item: { id: string }) => inActiveWorkflow(workspace.id, item.id);
  const items = board.items.filter((item) => matchesSearch(item, search));
  const openItem = board.items.find((item) => item.id === openItemId);
  const waitingCount = board.items.filter((item) => agentMap.get(item.id)?.status === 'WAITING_INPUT').length;
  const outOfModel = board.sources.filter((source) => source.modelStatus !== 'synced');

  if (converting) return <BoardConversionPanel workspaceId={workspace.id} sourceId={converting} onClose={() => setConverting(null)} />;
  if (adding) {
    return (
      <BoardSetup workspace={workspace} hasStudioTasks={board.sources.some((source) => source.provider === 'STUDIO')} onClose={() => setAdding(false)} />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {board.sources.map((source) => (
            <SourceChip key={source.id} source={source} />
          ))}
          <button type="button" onClick={() => setAdding(true)} className="text-xs text-muted hover:text-accent" title="Juntar outro quadro (GitHub, GitLab ou do Studio) a este">
            + Adicionar quadro
          </button>
          {waitingCount > 0 && <Badge tone="warning">{waitingCount} aguardando você</Badge>}
          <SyncStatus sources={board.sources} />
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
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Lê os quadros nos provedores agora">
            {refresh.isPending ? 'Atualizando...' : 'Atualizar'}
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nova tarefa
          </Button>
        </div>
      </header>
      <ErrorText error={refresh.error ?? move.error} />
      {outOfModel.map((source) => (
        <div
          key={source.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <span className="text-amber-200">
            {source.modelStatus === 'pending'
              ? `"${source.title}" ainda não segue o modelo do Studio, e as tarefas dele não aparecem aqui.`
              : `"${source.title}" foi alterado fora do Studio e não está mais igual ao modelo.`}
            {source.modelSyncError && <span className="ml-1 text-xs text-red-300">({source.modelSyncError})</span>}
          </span>
          <Button size="sm" variant="primary" onClick={() => setConverting(source.id)}>
            {source.modelStatus === 'pending' ? 'Converter para o modelo' : 'Sincronizar com o modelo'}
          </Button>
        </div>
      ))}

      {view === 'cards' ? (
        <KanbanView
          board={board}
          items={items}
          agents={agentMap}
          onOpen={(item) => setOpenItemId(item.id)}
          onMove={(item, columnId) => move.mutate({ itemId: item.id, columnId })}
          inWorkflow={inWorkflow}
        />
      ) : (
        <TaskTable board={board} items={items} agents={agentMap} onOpen={(item) => setOpenItemId(item.id)} inWorkflow={inWorkflow} />
      )}

      {openItem && (
        <TaskDrawer
          workspace={workspace}
          board={board}
          item={openItem}
          agent={agentMap.get(openItem.id)}
          onClose={() => setOpenItemId(null)}
          inWorkflow={inWorkflow(openItem)}
        />
      )}
      {creating && <NewTaskForm workspaceId={workspace.id} board={board} onClose={() => setCreating(false)} />}
    </div>
  );
}
