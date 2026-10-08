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
  useUpdateStatusMap,
} from '../../api/boards';
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

/** Board link management in the workspace configuration: column roles and unlink. */
export function BoardLinkSection({ workspaceId }: { workspaceId: string }) {
  const link = useBoardLink(workspaceId);
  const board = useBoard(workspaceId, Boolean(link.data));

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Quadro de tarefas</h2>
      <ErrorText error={link.error ?? board.error} />
      {link.data === null && (
        <p className="mt-2 text-sm text-muted">Nenhum quadro vinculado. Vincule ou crie um na aba Quadro.</p>
      )}
      {link.data && board.data && (
        <LinkedBoard key={JSON.stringify(link.data.statusMap)} workspaceId={workspaceId} link={link.data} columns={board.data.columns} />
      )}
    </section>
  );
}

function LinkedBoard({ workspaceId, link, columns }: { workspaceId: string; link: BoardLink; columns: BoardOption[] }) {
  const [map, setMap] = useState<StatusMap>(link.statusMap);
  const update = useUpdateStatusMap(workspaceId);
  const unlink = useUnlinkBoard(workspaceId);
  const isDirty = JSON.stringify(map) !== JSON.stringify(link.statusMap);

  const handleUnlink = () => {
    if (window.confirm(`Desvincular "${link.title}" deste workspace? O quadro continua existindo no provedor.`)) unlink.mutate();
  };

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="info">{boardProviderLabels[link.provider]}</Badge>
        <a href={link.url} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">
          {link.title} ↗
        </a>
        <span className="text-xs text-muted">{link.ownerPath}</span>
      </div>
      <p className="mt-1 text-xs text-muted">O quadro é próprio deste workspace e não entra na cópia de configuração.</p>

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
        <Button variant="danger" onClick={handleUnlink} disabled={unlink.isPending}>
          Desvincular quadro
        </Button>
        <ErrorText error={update.error ?? unlink.error} />
      </div>
    </>
  );
}
