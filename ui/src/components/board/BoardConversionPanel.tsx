import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type ConversionMapping,
  type ConversionState,
  boardColors,
  boardProviderLabels,
  useApplyConversion,
  useBoardConversion,
  usePreviewConversion,
} from '../../api/boards';
import { Button } from '../Button';
import { ErrorText, Select } from '../form';

type Preview = { changes: string[]; lostValues: { field: string; option: string | null; items: number }[]; movedCards: number };

const normalize = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** Converts one board of the workspace to the Studio model (or syncs it again after a change on the provider). */
export function BoardConversionPanel({ workspaceId, sourceId, onClose }: { workspaceId: string; sourceId: string; onClose: () => void }) {
  const state = useBoardConversion(workspaceId, sourceId);
  if (state.error) {
    return (
      <div className="space-y-3">
        <ErrorText error={state.error} />
        <Button onClick={onClose}>Voltar ao quadro</Button>
      </div>
    );
  }
  if (!state.data) return <p className="text-sm text-muted">Lendo o quadro no provedor...</p>;
  return <ConversionForm workspaceId={workspaceId} sourceId={sourceId} state={state.data} onClose={onClose} />;
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function ConversionForm({ workspaceId, sourceId, state, onClose }: { workspaceId: string; sourceId: string; state: ConversionState; onClose: () => void }) {
  const [mapping, setMapping] = useState<ConversionMapping>(state.suggestion);
  const [plan, setPlan] = useState<Preview | null>(null);
  const preview = usePreviewConversion(workspaceId, sourceId);
  const apply = useApplyConversion(workspaceId, sourceId);
  const provider = boardProviderLabels[state.provider];
  const pending = state.link.modelStatus === 'pending';

  useEffect(() => setPlan(null), [mapping]);

  const setColumn = (columnId: string, modelId: string) => setMapping({ ...mapping, columns: { ...mapping.columns, [columnId]: modelId } });
  const setField = (fieldId: string, modelFieldId: string | null) => {
    const field = state.current.fields.find((entry) => entry.id === fieldId)!;
    const modelField = state.model.fields.find((entry) => entry.id === modelFieldId);
    // Options of the newly chosen field are matched by name again.
    const options = Object.fromEntries(
      field.options.map((option) => [option.id!, modelField?.options.find((entry) => normalize(entry.name) === normalize(option.name))?.id ?? null]),
    );
    setMapping({ ...mapping, fields: { ...mapping.fields, [fieldId]: modelFieldId }, options: { ...mapping.options, [fieldId]: options } });
  };
  const setOption = (fieldId: string, optionId: string, modelOptionId: string | null) =>
    setMapping({ ...mapping, options: { ...mapping.options, [fieldId]: { ...mapping.options[fieldId], [optionId]: modelOptionId } } });

  const unmappedColumns = state.current.columns.filter((column) => !mapping.columns[column.id!]);
  const newColumns = state.model.columns.filter((column) => !column.fixed && !Object.values(mapping.columns).includes(column.id));
  const newFields = state.model.fields.filter((field) => !Object.values(mapping.fields).includes(field.id));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            {pending ? 'Converter para o modelo do Studio' : 'Sincronizar com o modelo do Studio'}: {state.link.title}
          </h2>
          <p className="max-w-3xl text-xs text-muted">
            Diga a que parte do{' '}
            <Link to="/board?tab=model" className="text-accent hover:underline">
              modelo
            </Link>{' '}
            corresponde cada coluna, campo e opção do quadro no {provider}. O que corresponde é renomeado (os cards ficam), o que falta é
            criado e o resto é removido no {provider}.
          </p>
          {state.link.modelSyncError && <p className="mt-1 text-xs text-red-300">Última tentativa: {state.link.modelSyncError}</p>}
        </div>
        <Button onClick={onClose}>Voltar ao quadro</Button>
      </header>

      <section>
        <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Colunas</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/60 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">No {provider}</th>
                <th className="px-3 py-2 font-medium">Cards</th>
                <th className="px-3 py-2 font-medium">No modelo</th>
              </tr>
            </thead>
            <tbody>
              {state.current.columns.map((column) => (
                <tr key={column.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Dot color={boardColors[column.color]} />
                      {column.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted tabular-nums">{state.columnItems[column.id!] ?? 0}</td>
                  <td className="px-3 py-2">
                    <Select value={mapping.columns[column.id!] ?? ''} onChange={(event) => setColumn(column.id!, event.target.value)} className="max-w-xs">
                      <option value="">Escolha a coluna</option>
                      {state.model.columns.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                          {entry.fixed ? (entry.role === 'done' ? ' (fecha as issues)' : ' (issues abertas)') : ''}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {state.provider === 'GITLAB' && (
          <p className="mt-2 text-xs text-muted">
            No GitLab, as colunas do modelo com papel "A fazer" e "Concluído" são as issues abertas sem coluna e as fechadas.
          </p>
        )}
        {newColumns.length > 0 && <p className="mt-2 text-xs text-emerald-300">Serão criadas: {newColumns.map((column) => column.name).join(', ')}.</p>}
      </section>

      <section>
        <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Campos</h3>
        {state.current.fields.length === 0 && <p className="mt-2 text-sm text-muted">O quadro não tem campos de escolha.</p>}
        <div className="mt-2 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {state.current.fields.map((field) => {
            const modelField = state.model.fields.find((entry) => entry.id === mapping.fields[field.id!]);
            return (
              <div key={field.id} className="rounded-lg border border-border bg-panel p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{field.name}</span>
                  <Select value={mapping.fields[field.id!] ?? ''} onChange={(event) => setField(field.id!, event.target.value || null)} className="max-w-xs">
                    <option value="">Remover o campo</option>
                    {state.model.fields.map((entry) => (
                      <option key={entry.id} value={entry.id!}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {modelField && (
                  <ul className="mt-2 space-y-1">
                    {field.options.map((option) => (
                      <li key={option.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <Dot color={boardColors[option.color]} />
                          <span className="truncate">{option.name}</span>
                          <span className="text-xs text-muted tabular-nums">{state.optionItems[field.id!]?.[option.id!] ?? 0} card(s)</span>
                        </span>
                        <Select
                          value={mapping.options[field.id!]?.[option.id!] ?? ''}
                          onChange={(event) => setOption(field.id!, option.id!, event.target.value || null)}
                          className="max-w-[12rem]"
                        >
                          <option value="">Remover a opção</option>
                          {modelField.options.map((entry) => (
                            <option key={entry.id} value={entry.id!}>
                              {entry.name}
                            </option>
                          ))}
                        </Select>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {newFields.length > 0 && <p className="mt-2 text-xs text-emerald-300">Serão criados: {newFields.map((field) => field.name).join(', ')}.</p>}
      </section>

      <div className="sticky bottom-0 space-y-3 rounded-lg border border-border bg-panel p-4 shadow-lg">
        {!plan && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => preview.mutate(mapping, { onSuccess: setPlan })} disabled={unmappedColumns.length > 0 || preview.isPending}>
              {preview.isPending ? 'Conferindo...' : 'Revisar mudanças'}
            </Button>
            {unmappedColumns.length > 0 && (
              <span className="text-xs text-amber-300">Escolha a coluna do modelo para: {unmappedColumns.map((column) => column.name).join(', ')}.</span>
            )}
            <ErrorText error={preview.error} />
          </div>
        )}
        {plan && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">O que vai mudar no {provider}</h3>
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted">O quadro já está igual ao modelo.</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {plan.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            )}
            {plan.lostValues.map((lost) => (
              <p key={`${lost.field}-${lost.option}`} className="text-xs text-amber-300">
                {lost.items} card(s) perdem o valor de "{lost.field}"{lost.option ? ` ("${lost.option}")` : ''}.
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => apply.mutate(mapping, { onSuccess: onClose })} disabled={apply.isPending}>
                {apply.isPending ? `Aplicando no ${provider}...` : plan.changes.length === 0 ? 'Marcar como no modelo' : `Aplicar no ${provider}`}
              </Button>
              <Button onClick={() => setPlan(null)} disabled={apply.isPending}>
                Continuar ajustando
              </Button>
              <ErrorText error={apply.error} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
