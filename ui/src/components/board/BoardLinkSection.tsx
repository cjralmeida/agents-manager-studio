import { Link } from 'react-router';
import { type BoardSource, boardProviderLabels, useBoardSources, useUnlinkSource, useUpdateBoardSettings } from '../../api/boards';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';

/** Board behavior in the workspace configuration: refresh interval and where columns and fields come from. */
export function BoardBehaviorSection({ workspaceId }: { workspaceId: string }) {
  const sources = useBoardSources(workspaceId);

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Quadro de tarefas</h2>
      <ErrorText error={sources.error} />
      {sources.data?.length === 0 && <p className="mt-2 text-sm text-muted">Nenhum quadro vinculado. Vincule ou crie um na aba Quadro de tarefas.</p>}
      {sources.data && sources.data.length > 0 && <BoardBehavior workspaceId={workspaceId} sources={sources.data} />}
    </section>
  );
}

/** The boards joined on the workspace board as connections: which ones, last read, remove (adding happens in the Quadro tab). */
export function BoardConnection({ workspaceId }: { workspaceId: string }) {
  const sources = useBoardSources(workspaceId);
  const unlink = useUnlinkSource(workspaceId);
  const boardTab = `/workspaces/${workspaceId}?tab=board`;
  if (sources.error) return <ErrorText error={sources.error} />;
  if (sources.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (sources.data.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nenhum quadro vinculado.{' '}
        <Link to={boardTab} className="text-accent hover:underline">
          Vincular ou criar na aba Quadro de tarefas
        </Link>
      </p>
    );
  }

  const handleUnlink = (source: BoardSource) => {
    const message =
      source.provider === 'STUDIO'
        ? 'Tirar as tarefas do Studio do quadro deste workspace? Elas ficam guardadas e voltam se forem adicionadas de novo.'
        : `Tirar "${source.title}" do quadro deste workspace? O quadro continua existindo no ${boardProviderLabels[source.provider]}.`;
    if (window.confirm(message)) unlink.mutate(source.id);
  };

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {sources.data.map((source) => (
          <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="info">{boardProviderLabels[source.provider]}</Badge>
                {source.provider === 'STUDIO' ? (
                  <span className="font-medium">{source.title}</span>
                ) : (
                  <a href={source.url} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">
                    {source.title} ↗
                  </a>
                )}
                {source.provider !== 'STUDIO' && <span className="text-xs text-muted">{source.ownerPath}</span>}
                {source.modelStatus === 'pending' && <Badge tone="warning">fora do modelo</Badge>}
              </div>
              <p className="text-xs text-muted">
                {source.lastSyncError
                  ? `Falha na última leitura: ${source.lastSyncError}`
                  : source.lastSyncedAt
                    ? `Lido ${timeAgo(source.lastSyncedAt)}.`
                    : 'Ainda não lido.'}
              </p>
            </div>
            <Button size="sm" variant="danger" onClick={() => handleUnlink(source)} disabled={unlink.isPending}>
              Remover
            </Button>
          </li>
        ))}
      </ul>
      <Link to={boardTab} className="inline-block text-xs text-accent hover:underline">
        Adicionar outro quadro na aba Quadro de tarefas →
      </Link>
      <ErrorText error={unlink.error} />
    </div>
  );
}

const INTERVALS = [1, 2, 5, 10, 15];

/** How often the server reads the boards (and starts board-triggered workflows); 2 minutes keeps provider calls low. */
function RefreshInterval({ workspaceId, sources }: { workspaceId: string; sources: BoardSource[] }) {
  const update = useUpdateBoardSettings(workspaceId);
  return (
    <div className="mt-4 max-w-sm">
      <Field label="Atualização automática" hint="O server lê os quadros nesse intervalo e, em seguida, inicia os workflows que vigiam o quadro.">
        <Select
          value={Math.round((sources[0]?.refreshIntervalSec ?? 120) / 60)}
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

function BoardBehavior({ workspaceId, sources }: { workspaceId: string; sources: BoardSource[] }) {
  return (
    <>
      <p className="mt-1 text-xs text-muted">
        {sources.length === 1 ? `Quadro "${sources[0]!.title}".` : `Junta ${sources.length} quadros: ${sources.map((source) => source.title).join(', ')}.`} Os
        vínculos ficam na aba Conectores; aqui, como o Studio trabalha com eles.
      </p>

      <RefreshInterval workspaceId={workspaceId} sources={sources} />

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
