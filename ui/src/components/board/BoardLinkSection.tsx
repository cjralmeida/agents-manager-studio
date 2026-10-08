import { useState } from 'react';
import {
  type BoardLink,
  type BoardOption,
  type StatusMap,
  type StatusRole,
  boardProviderLabels,
  statusRoleLabels,
  useBoard,
  useBoardLink,
  useUnlinkBoard,
  useUpdateBoardSettings,
  useUpdateStatusMap,
} from '../../api/boards';
import { Link } from 'react-router';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';

const ROLE_HINTS: Record<StatusRole, string> = {
  todo: 'Onde ficam as tarefas novas.',
  inProgress: 'A tarefa vai para cá quando um agente é lançado.',
  review: 'A tarefa vai para cá quando o PR/MR é aberto.',
  done: 'Concluídas; o Studio não move para cá.',
  blocked: 'Agentes não podem ser lançados nestas tarefas.',
};

/** Board behavior in the workspace configuration: refresh interval and column roles. */
export function BoardBehaviorSection({ workspaceId }: { workspaceId: string }) {
  const link = useBoardLink(workspaceId);
  const board = useBoard(workspaceId, Boolean(link.data));

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Quadro de tarefas</h2>
      <ErrorText error={link.error ?? board.error} />
      {link.data === null && <p className="mt-2 text-sm text-muted">Nenhum quadro vinculado. Vincule ou crie um na aba Quadro.</p>}
      {link.data && board.data && (
        <BoardBehavior key={JSON.stringify(link.data.statusMap)} workspaceId={workspaceId} link={link.data} columns={board.data.columns} />
      )}
    </section>
  );
}

/** The linked board as a connection: which board, last read, unlink (linking happens in the Quadro tab). */
export function BoardConnection({ workspaceId }: { workspaceId: string }) {
  const link = useBoardLink(workspaceId);
  const unlink = useUnlinkBoard(workspaceId);
  if (link.error) return <ErrorText error={link.error} />;
  if (link.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (!link.data) {
    return (
      <p className="text-sm text-muted">
        Nenhum quadro vinculado.{' '}
        <Link to={`/workspaces/${workspaceId}?tab=board`} className="text-accent hover:underline">
          Vincular ou criar na aba Quadro
        </Link>
      </p>
    );
  }
  const data = link.data;
  const handleUnlink = () => {
    if (window.confirm(`Desvincular "${data.title}" deste workspace? O quadro continua existindo no provedor.`)) unlink.mutate();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="info">{boardProviderLabels[data.provider]}</Badge>
        <a href={data.url} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">
          {data.title} ↗
        </a>
        <span className="text-xs text-muted">{data.ownerPath}</span>
      </div>
      <p className="text-xs text-muted">
        {data.lastSyncError
          ? `Falha na última leitura: ${data.lastSyncError}`
          : data.lastSyncedAt
            ? `Lido ${timeAgo(data.lastSyncedAt)}, automático a cada ${Math.round(data.refreshIntervalSec / 60)} min.`
            : 'Ainda não lido.'}
      </p>
      <Button size="sm" variant="danger" onClick={handleUnlink} disabled={unlink.isPending}>
        Desvincular quadro
      </Button>
      <ErrorText error={unlink.error} />
    </div>
  );
}

const INTERVALS = [1, 2, 5, 10, 15];

/** How often the server reads the board (and starts board-triggered workflows); 2 minutes keeps provider calls low. */
function RefreshInterval({ workspaceId, link }: { workspaceId: string; link: BoardLink }) {
  const update = useUpdateBoardSettings(workspaceId);
  return (
    <div className="mt-4 max-w-sm">
      <Field label="Atualização automática" hint="O server lê o quadro nesse intervalo e, em seguida, inicia os workflows que vigiam o quadro.">
        <Select
          value={Math.round(link.refreshIntervalSec / 60)}
          onChange={(event) => update.mutate({ refreshIntervalSec: Number(event.target.value) * 60 })}
          disabled={update.isPending}
        >
          {INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              A cada {minutes} min{minutes === 2 ? ' (recomendado)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <ErrorText error={update.error} />
    </div>
  );
}

function BoardBehavior({ workspaceId, link, columns }: { workspaceId: string; link: BoardLink; columns: BoardOption[] }) {
  const [map, setMap] = useState<StatusMap>(link.statusMap);
  const update = useUpdateStatusMap(workspaceId);
  const isDirty = JSON.stringify(map) !== JSON.stringify(link.statusMap);

  return (
    <>
      <p className="mt-1 text-xs text-muted">Quadro "{link.title}". O vínculo fica na aba Conectores; aqui, como o Studio trabalha com ele.</p>

      <RefreshInterval workspaceId={workspaceId} link={link} />

      <h3 className="mt-5 text-sm font-medium">Papel das colunas</h3>
      <p className="mt-1 text-xs text-muted">Usado para mover as tarefas automaticamente conforme o agente avança.</p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(statusRoleLabels) as StatusRole[]).map((role) => (
          <Field key={role} label={statusRoleLabels[role]} hint={ROLE_HINTS[role]}>
            <Select
              value={map[role] ?? ''}
              onChange={(event) => {
                const { [role]: _removed, ...rest } = map;
                setMap(event.target.value ? { ...rest, [role]: event.target.value } : rest);
              }}
            >
              <option value="">Nenhuma</option>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => update.mutate(map)} disabled={!isDirty || update.isPending}>
          {update.isPending ? 'Salvando...' : 'Salvar papéis'}
        </Button>
        <ErrorText error={update.error} />
      </div>
    </>
  );
}
