import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BoardField, BoardItem, BoardOption } from '../../api/boards';
import { Button } from '../Button';
import { Select } from '../form';
import { MultiSelect } from '../MultiSelect';

/**
 * Filters of a board: any field (Área, Prioridade, Tipo, Decisão...), who is assigned, what the agents are doing and
 * which columns show. Kept in the URL, so a filtered board can be linked and survives a reload.
 */

const NONE = '__none__';
type AgentFilter = '' | 'working' | 'waiting' | 'none';

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);

export interface BoardFilterState {
  fields: Record<string, string[]>;
  assignees: string[];
  agent: AgentFilter;
  /** Columns shown; empty shows all. */
  columns: string[];
}

export function useBoardFilters() {
  const [params, setParams] = useSearchParams();
  const fields: Record<string, string[]> = {};
  for (const [key, value] of params.entries()) if (key.startsWith('campo.')) fields[key.slice('campo.'.length)] = list(value);
  const state: BoardFilterState = {
    fields,
    assignees: list(params.get('responsavel')),
    agent: (params.get('agente') ?? '') as AgentFilter,
    columns: list(params.get('colunas')),
  };
  const set = (key: string, values: string[] | string) => {
    const value = Array.isArray(values) ? values.join(',') : values;
    if (value) params.set(key, value);
    else params.delete(key);
    setParams(params, { replace: true });
  };
  const clear = () => {
    for (const key of [...params.keys()]) if (key.startsWith('campo.') || ['responsavel', 'agente', 'colunas'].includes(key)) params.delete(key);
    setParams(params, { replace: true });
  };
  const active =
    Object.values(fields).filter((values) => values.length > 0).length + (state.assignees.length > 0 ? 1 : 0) + (state.agent ? 1 : 0) + (state.columns.length > 0 ? 1 : 0);
  return { state, set, clear, active };
}

/** Whether an item passes the filters (the agent working on it, if any, by status). */
export function matchesFilters(item: BoardItem, state: BoardFilterState, agentStatus: string | undefined) {
  for (const [fieldId, values] of Object.entries(state.fields)) {
    if (values.length === 0) continue;
    const value = item.fields[fieldId] ?? NONE;
    if (!values.includes(value)) return false;
  }
  if (state.assignees.length > 0) {
    const people = item.assignees.length > 0 ? item.assignees : [NONE];
    if (!people.some((person) => state.assignees.includes(person))) return false;
  }
  if (state.columns.length > 0 && !state.columns.includes(item.columnId ?? '')) return false;
  const working = agentStatus !== undefined && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(agentStatus);
  if (state.agent === 'working' && !working) return false;
  if (state.agent === 'waiting' && agentStatus !== 'WAITING_INPUT') return false;
  if (state.agent === 'none' && working) return false;
  return true;
}

/** Only the columns the filter shows (all of them without the filter). */
export function visibleColumns(columns: BoardOption[], state: BoardFilterState) {
  return state.columns.length > 0 ? columns.filter((column) => state.columns.includes(column.id)) : columns;
}

export function BoardFilterBar({
  fields,
  columns,
  items,
  filters,
}: {
  fields: BoardField[];
  columns: BoardOption[];
  items: BoardItem[];
  filters: ReturnType<typeof useBoardFilters>;
}) {
  const [open, setOpen] = useState(filters.active > 0);
  const { state, set, clear } = filters;
  const people = [...new Set(items.flatMap((item) => item.assignees))].sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setOpen(!open)} title="Filtrar as tarefas do quadro">
          Filtros{filters.active > 0 ? ` · ${filters.active}` : ''}
        </Button>
        {filters.active > 0 && (
          <button type="button" onClick={clear} className="text-xs text-muted hover:text-accent">
            Limpar filtros
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-panel p-3">
          {fields.map((field) => (
            <label key={field.id} className="w-48 text-xs text-muted">
              {field.name}
              <MultiSelect
                options={[...field.options.map((option) => ({ value: option.id, label: option.name })), { value: NONE, label: `Sem ${field.name.toLowerCase()}` }]}
                selected={state.fields[field.id] ?? []}
                onChange={(values) => set(`campo.${field.id}`, values)}
                placeholder="Todas"
              />
            </label>
          ))}
          <label className="w-48 text-xs text-muted">
            Responsável
            <MultiSelect
              options={[...people.map((person) => ({ value: person, label: `@${person}` })), { value: NONE, label: 'Sem responsável' }]}
              selected={state.assignees}
              onChange={(values) => set('responsavel', values)}
              placeholder="Todos"
            />
          </label>
          <label className="w-48 text-xs text-muted">
            Agente
            <Select value={state.agent} onChange={(event) => set('agente', event.target.value)}>
              <option value="">Qualquer</option>
              <option value="working">Com agente trabalhando</option>
              <option value="waiting">Aguardando você</option>
              <option value="none">Sem agente</option>
            </Select>
          </label>
          <label className="w-48 text-xs text-muted">
            Colunas
            <MultiSelect
              options={columns.map((column) => ({ value: column.id, label: column.name }))}
              selected={state.columns}
              onChange={(values) => set('colunas', values)}
              placeholder="Todas"
            />
          </label>
        </div>
      )}
    </div>
  );
}
