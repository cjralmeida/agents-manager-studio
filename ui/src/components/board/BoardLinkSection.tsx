import { useState } from 'react';
import {
  type BoardLink,
  boardProviderLabels,
  useBoard,
  useBoardLink,
  useUnlinkBoard,
  useUpdateBoardSettings,
} from '../../api/boards';
import { Link } from 'react-router';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';


/** Board behavior in the workspace configuration: refresh interval and column roles. */
export function BoardBehaviorSection({ workspaceId }: { workspaceId: string }) {
  const link = useBoardLink(workspaceId);
  const board = useBoard(workspaceId, Boolean(link.data));

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Quadro de tarefas</h2>
      <ErrorText error={link.error ?? board.error} />
      {link.data === null && <p className="mt-2 text-sm text-muted">Nenhum quadro vinculado. Vincule ou crie um na aba Quadro de tarefas.</p>}
      {link.data && board.data && (
        <BoardBehavior workspaceId={workspaceId} link={link.data} />
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
          Vincular ou criar na aba Quadro de tarefas
        </Link>
      </p>
    );
  }
  const data = link.data;
  const handleUnlink = () => {
    const message =
      data.provider === 'STUDIO'
        ? 'Remover o quadro do Studio deste workspace? As tarefas ficam guardadas e voltam se o quadro for criado de novo.'
        : `Desvincular "${data.title}" deste workspace? O quadro continua existindo no provedor.`;
    if (window.confirm(message)) unlink.mutate();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="info">{boardProviderLabels[data.provider]}</Badge>
        {data.provider === 'STUDIO' ? (
          <Link to={data.url} className="font-medium hover:text-accent">
            {data.title}
          </Link>
        ) : (
          <a href={data.url} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">
            {data.title} ↗
          </a>
        )}
        {data.provider !== 'STUDIO' && <span className="text-xs text-muted">{data.ownerPath}</span>}
      </div>
      <p className="text-xs text-muted">
        {data.lastSyncError
          ? `Falha na última leitura: ${data.lastSyncError}`
          : data.lastSyncedAt
            ? `Lido ${timeAgo(data.lastSyncedAt)}, automático a cada ${Math.round(data.refreshIntervalSec / 60)} min.`
            : 'Ainda não lido.'}
      </p>
      <Button size="sm" variant="danger" onClick={handleUnlink} disabled={unlink.isPending}>
        {data.provider === 'STUDIO' ? 'Remover quadro' : 'Desvincular quadro'}
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

function BoardBehavior({ workspaceId, link }: { workspaceId: string; link: BoardLink }) {
  return (
    <>
      <p className="mt-1 text-xs text-muted">Quadro "{link.title}". O vínculo fica na aba Conectores; aqui, como o Studio trabalha com ele.</p>

      <RefreshInterval workspaceId={workspaceId} link={link} />

      <p className="mt-4 text-xs text-muted">
        Colunas, campos e o papel de cada coluna para os agentes vêm do{' '}
        <Link to="/board?tab=model" className="text-accent hover:underline">
          modelo de quadro
        </Link>
        , que vale para todos os workspaces.
      </p>
    </>
  );
}
