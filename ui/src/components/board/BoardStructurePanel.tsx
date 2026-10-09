import { useEffect, useState } from 'react';
import {
  type BoardStructure,
  type BoardStructureState,
  type StructurePlan,
  boardProviderLabels,
  useApplyBoardStructure,
  useBoardStructure,
  usePreviewBoardStructure,
} from '../../api/boards';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';
import { BoardStructureEditor } from './BoardStructureEditor';

/** Edits the columns and fields of the linked board; the changes go to the provider only after a review. */
export function BoardStructurePanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const state = useBoardStructure(workspaceId);
  const [applied, setApplied] = useState<number | null>(null);

  if (state.error) {
    return (
      <div className="space-y-3">
        <ErrorText error={state.error} />
        <Button onClick={onClose}>Voltar ao quadro</Button>
      </div>
    );
  }
  if (!state.data) return <p className="text-sm text-muted">Lendo a estrutura do quadro no provedor...</p>;
  return (
    <div className="space-y-3">
      {applied !== null && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Estrutura aplicada no {boardProviderLabels[state.data.provider]} ({applied} mudança(s)). O quadro já foi relido.
        </p>
      )}
      <StructureForm
        key={state.dataUpdatedAt}
        workspaceId={workspaceId}
        state={state.data}
        onClose={onClose}
        onApplied={(count) => {
          setApplied(count);
          void state.refetch();
        }}
      />
    </div>
  );
}

function StructureForm({
  workspaceId,
  state,
  onClose,
  onApplied,
}: {
  workspaceId: string;
  state: BoardStructureState;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const [draft, setDraft] = useState<BoardStructure>(state.structure);
  const [plan, setPlan] = useState<StructurePlan | null>(null);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const preview = usePreviewBoardStructure(workspaceId);
  const apply = useApplyBoardStructure(workspaceId);
  const provider = boardProviderLabels[state.provider];
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.structure);

  // Any edit after a review invalidates it.
  useEffect(() => setPlan(null), [draft]);

  const review = () =>
    preview.mutate(draft, {
      onSuccess: (result) => {
        setPlan(result);
        setMoves({});
      },
    });

  // Cards can only move to columns that exist now and stay (new ones get an id only when applied).
  const fixedIds = state.fixedColumns ? ['open', 'closed'] : [];
  const remainingColumns = state.allColumns.filter((column) => fixedIds.includes(column.id) || draft.columns.some((entry) => entry.id === column.id));
  const movesReady = plan?.removedColumns.every((removed) => moves[removed.id]) ?? false;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Estrutura do quadro</h2>
          <p className="text-xs text-muted">
            Edite aqui e aplique no {provider}. As tarefas continuam no {provider}; renomear uma coluna ou opção mantém os cards nela.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setDraft(state.structure)} disabled={!dirty}>
            Desfazer alterações
          </Button>
          <Button onClick={onClose}>Voltar ao quadro</Button>
        </div>
      </header>

      <BoardStructureEditor
        value={draft}
        onChange={setDraft}
        fixedColumns={state.fixedColumns}
        columnItems={state.columnItems}
        optionItems={state.optionItems}
      />

      <div className="sticky bottom-0 space-y-3 rounded-lg border border-border bg-panel p-4 shadow-lg">
        {!plan && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={review} disabled={!dirty || preview.isPending}>
              {preview.isPending ? 'Conferindo...' : 'Revisar mudanças'}
            </Button>
            {dirty ? <span className="text-xs text-amber-300">Alterações não aplicadas</span> : <span className="text-xs text-muted">Nada alterado.</span>}
            <ErrorText error={preview.error} />
          </div>
        )}

        {plan && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">O que vai mudar no {provider}</h3>
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted">Nada a mudar.</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {plan.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            )}

            {plan.removedColumns.map((removed) => (
              <div key={removed.id} className="max-w-md">
                <Field label={`Para onde vão os ${removed.items} card(s) de "${removed.name}"?`}>
                  <Select value={moves[removed.id] ?? ''} onChange={(event) => setMoves({ ...moves, [removed.id]: event.target.value })}>
                    <option value="">Escolha a coluna</option>
                    {remainingColumns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ))}
            {plan.lostValues.map((lost) => (
              <p key={`${lost.field}-${lost.option}`} className="text-xs text-amber-300">
                {lost.items} card(s) perdem o valor de "{lost.field}"{lost.option ? ` ("${lost.option}")` : ''}.
              </p>
            ))}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() =>
                  apply.mutate(
                    { structure: draft, columnMoves: moves },
                    {
                      onSuccess: (result) => onApplied(result.applied),
                    },
                  )
                }
                disabled={plan.changes.length === 0 || !movesReady || apply.isPending}
              >
                {apply.isPending ? `Aplicando no ${provider}...` : `Aplicar no ${provider}`}
              </Button>
              <Button onClick={() => setPlan(null)} disabled={apply.isPending}>
                Continuar editando
              </Button>
              <ErrorText error={apply.error} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
