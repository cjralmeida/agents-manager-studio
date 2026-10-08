import { useState } from 'react';
import { type Board, useBoard, useBoardLink } from '../../api/boards';
import {
  type Sentinel,
  useCreateSentinel,
  useDeleteSentinel,
  useRunSentinel,
  useSentinels,
  useUpdateSentinel,
} from '../../api/sentinels';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { OptionChip } from '../board/OptionChip';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { SentinelForm } from './SentinelForm';

export function SentinelsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const link = useBoardLink(workspace.id);
  const board = useBoard(workspace.id, Boolean(link.data));
  const sentinels = useSentinels(workspace.id);

  if (link.isPending || sentinels.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (!link.data) {
    return <p className="text-sm text-muted">Vincule um quadro de tarefas na aba Quadro: as sentinelas vigiam esse quadro.</p>;
  }
  const error = board.error ?? sentinels.error;
  if (error) return <ErrorText error={error} />;
  if (!board.data || !sentinels.data) return <p className="text-sm text-muted">Carregando...</p>;

  return <SentinelList workspace={workspace} board={board.data} sentinels={sentinels.data} />;
}

function SentinelList({ workspace, board, sentinels }: { workspace: WorkspaceDetail; board: Board; sentinels: Sentinel[] }) {
  const [editing, setEditing] = useState<Sentinel | 'new' | null>(null);
  const create = useCreateSentinel(workspace.id);
  const update = useUpdateSentinel(workspace.id);
  const minutes = Math.round(board.link.refreshIntervalSec / 60);

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Sentinelas vigiam o quadro <span className="text-white">{board.title}</span>, que é atualizado a cada {minutes} min,
          e lançam agentes para as tarefas do tipo delas. Elas voltam a vigiar sozinhas quando o Studio reinicia e pausam
          quando a janela de 5 horas do Claude ou o Docker estão no limite.
        </p>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Nova sentinela
          </Button>
        )}
      </div>

      {editing !== null && (
        <SentinelForm
          key={editing === 'new' ? 'new' : editing.id}
          board={board}
          initial={editing === 'new' ? undefined : editing}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => {
            const done = { onSuccess: () => setEditing(null) };
            if (editing === 'new') create.mutate(input, done);
            else update.mutate({ id: editing.id, ...input }, done);
          }}
        />
      )}

      {sentinels.length === 0 && editing === null && (
        <p className="text-sm text-muted">Nenhuma sentinela neste workspace ainda.</p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {sentinels.map((sentinel) => (
          <SentinelCard key={sentinel.id} workspaceId={workspace.id} board={board} sentinel={sentinel} onEdit={() => setEditing(sentinel)} />
        ))}
      </div>
    </div>
  );
}

function SentinelCard({ workspaceId, board, sentinel, onEdit }: { workspaceId: string; board: Board; sentinel: Sentinel; onEdit: () => void }) {
  const run = useRunSentinel(workspaceId);
  const update = useUpdateSentinel(workspaceId);
  const remove = useDeleteSentinel(workspaceId);

  const column = board.columns.find((entry) => entry.id === (sentinel.columnId ?? board.link.statusMap.todo));
  const filters = board.fields.flatMap((field) =>
    (sentinel.fieldFilters[field.id] ?? []).flatMap((optionId) => {
      const option = field.options.find((entry) => entry.id === optionId);
      return option ? [{ field, option }] : [];
    }),
  );
  const repositories = sentinel.repositories.map(
    (path) => board.repositories.find((repo) => repo.path === path)?.projectName ?? path,
  );

  const handleDelete = () => {
    if (window.confirm(`Excluir a sentinela "${sentinel.name}"? Os agentes que ela lançou continuam existindo.`)) remove.mutate(sentinel.id);
  };

  return (
    <article className={`rounded-lg border bg-panel p-4 ${sentinel.isEnabled ? 'border-border' : 'border-border opacity-70'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{sentinel.name}</h3>
          <p className="mt-0.5 text-xs text-muted">
            Vigia {column ? `"${column.name}"` : 'a coluna "A fazer"'} · {sentinel.model} · até {sentinel.maxConcurrent} agente(s)
          </p>
        </div>
        {sentinel.isEnabled ? <Badge tone="success">Ativa</Badge> : <Badge>Desativada</Badge>}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {filters.length === 0 && repositories.length === 0 && <span className="text-xs text-muted">Qualquer tarefa da coluna</span>}
        {filters.map(({ field, option }) => (
          <OptionChip key={`${field.id}:${option.id}`} option={option} title={`${field.name}: ${option.name}`} />
        ))}
        {repositories.map((name) => (
          <Badge key={name}>{name}</Badge>
        ))}
        {sentinel.onlyUnassigned && <Badge>sem responsável</Badge>}
      </div>

      {sentinel.statusMessage && <p className="mt-3 text-xs text-gray-300">{sentinel.statusMessage}</p>}
      <p className="mt-1 text-[11px] text-muted">
        {sentinel.workingAgents} trabalhando · {sentinel.totalAgents} lançado(s)
        {sentinel.lastCheckedAt && ` · verificada ${timeAgo(sentinel.lastCheckedAt)}`}
        {sentinel.lastLaunchAt && ` · último lançamento ${timeAgo(sentinel.lastLaunchAt)}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => run.mutate(sentinel.id)} disabled={!sentinel.isEnabled || run.isPending}>
          {run.isPending ? 'Verificando...' : 'Verificar agora'}
        </Button>
        <Button size="sm" onClick={() => update.mutate({ id: sentinel.id, isEnabled: !sentinel.isEnabled })} disabled={update.isPending}>
          {sentinel.isEnabled ? 'Desativar' : 'Ativar'}
        </Button>
        <Button size="sm" onClick={onEdit}>
          Editar
        </Button>
        <Button size="sm" variant="danger" onClick={handleDelete} disabled={remove.isPending}>
          Excluir
        </Button>
      </div>
      <ErrorText error={run.error ?? update.error ?? remove.error} />
    </article>
  );
}
