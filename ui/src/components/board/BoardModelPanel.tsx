import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type BoardModel,
  type ModelState,
  type PropagationResult,
  type StructurePlan,
  boardProviderLabels,
  useApplyModel,
  useBoardModel,
  usePreviewModel,
} from '../../api/boards';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';
import { BoardStructureEditor } from './BoardStructureEditor';

const statusBadges = {
  synced: <Badge tone="success">No modelo</Badge>,
  drift: <Badge tone="warning">Fora do modelo</Badge>,
  pending: <Badge>Não convertido</Badge>,
};

const resultTones = { applied: 'text-emerald-300', skipped: 'text-amber-300', failed: 'text-red-300' } as const;

/** The Studio board model: edited here and applied to every workspace board that follows it. */
export function BoardModelPanel() {
  const state = useBoardModel();
  const [results, setResults] = useState<PropagationResult[] | null>(null);

  if (state.error) return <ErrorText error={state.error} />;
  if (!state.data) return <p className="text-sm text-muted">Carregando o modelo...</p>;

  return (
    <div className="space-y-6">
      {results && <PropagationResults results={results} />}
      <ModelForm
        key={state.dataUpdatedAt}
        state={state.data}
        onApplied={(next) => {
          setResults(next);
          void state.refetch();
        }}
      />
      <BoardsList boards={state.data.boards} />
    </div>
  );
}

function PropagationResults({ results }: { results: PropagationResult[] }) {
  return (
    <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <h3 className="text-sm font-medium text-emerald-300">Modelo salvo</h3>
      {results.length === 0 ? (
        <p className="mt-1 text-sm text-muted">Nenhum quadro vinculado para atualizar.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {results.map((result) => (
            <li key={result.workspaceId}>
              <span className="font-medium">{result.workspaceName}:</span> <span className={resultTones[result.status]}>{result.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ModelForm({ state, onApplied }: { state: ModelState; onApplied: (results: PropagationResult[]) => void }) {
  const [draft, setDraft] = useState<BoardModel>(state.model);
  const [plan, setPlan] = useState<StructurePlan | null>(null);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const preview = usePreviewModel();
  const apply = useApplyModel();
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.model);
  const synced = state.boards.filter((board) => board.modelStatus === 'synced').length;

  // Any edit after a review invalidates it.
  useEffect(() => setPlan(null), [draft]);

  // Cards of a removed column can only go to a column that exists now and stays.
  const targets = draft.columns.filter((column) => column.id !== null && state.model.columns.some((entry) => entry.id === column.id));
  const movesReady = plan?.removedColumns.every((removed) => moves[removed.id]) ?? false;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Modelo de quadro</h2>
          <p className="max-w-3xl text-xs text-muted">
            Todos os quadros dos workspaces seguem este modelo. Ao aplicar, a mudança vai para os {synced} quadro(s) que estão no modelo;
            renomear uma coluna ou opção mantém os cards nela.
          </p>
        </div>
        <Button onClick={() => setDraft(state.model)} disabled={!dirty}>
          Desfazer alterações
        </Button>
      </header>

      <BoardStructureEditor value={draft} onChange={setDraft} columnItems={state.usage.columns} optionItems={state.usage.options} />

      <div className="sticky bottom-0 space-y-3 rounded-lg border border-border bg-panel p-4 shadow-lg">
        {!plan && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => preview.mutate(draft, { onSuccess: (result) => (setPlan(result), setMoves({})) })} disabled={!dirty || preview.isPending}>
              {preview.isPending ? 'Conferindo...' : 'Revisar mudanças'}
            </Button>
            {dirty ? <span className="text-xs text-amber-300">Alterações não aplicadas</span> : <span className="text-xs text-muted">Nada alterado.</span>}
            <ErrorText error={preview.error} />
          </div>
        )}

        {plan && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">O que vai mudar no modelo e nos quadros</h3>
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
                <Field label={`Para onde vão os cards de "${removed.name}" (${removed.items} hoje)?`}>
                  <Select value={moves[removed.id] ?? ''} onChange={(event) => setMoves({ ...moves, [removed.id]: event.target.value })}>
                    <option value="">Escolha a coluna</option>
                    {targets.map((column) => (
                      <option key={column.id} value={column.id!}>
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
                onClick={() => apply.mutate({ model: draft, columnMoves: moves }, { onSuccess: (result) => onApplied(result.results) })}
                disabled={plan.changes.length === 0 || !movesReady || apply.isPending}
              >
                {apply.isPending ? 'Aplicando nos quadros...' : `Salvar e aplicar em ${synced} quadro(s)`}
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

function BoardsList({ boards }: { boards: ModelState['boards'] }) {
  return (
    <section>
      <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Quadros dos workspaces</h3>
      {boards.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nenhum workspace tem quadro vinculado.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
          {boards.map((board) => (
            <li key={board.workspaceId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">{board.workspaceName}</span>
                <Badge tone="info">{boardProviderLabels[board.provider]}</Badge>
                <a href={board.url} target="_blank" rel="noreferrer" className="truncate text-xs text-muted hover:text-accent">
                  {board.title} ↗
                </a>
                {statusBadges[board.modelStatus]}
              </div>
              <div className="flex items-center gap-3">
                {board.modelSyncError && (
                  <span className="max-w-xs truncate text-xs text-red-300" title={board.modelSyncError}>
                    {board.modelSyncError}
                  </span>
                )}
                {board.modelStatus !== 'synced' && (
                  <Link to={`/workspaces/${board.workspaceId}?tab=board`} className="text-xs text-accent hover:underline">
                    {board.modelStatus === 'pending' ? 'Converter' : 'Sincronizar'}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
