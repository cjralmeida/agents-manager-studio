import { type FormEvent, useState } from 'react';
import type { AgentModel } from '../../api/agents';
import type { Board } from '../../api/boards';
import type { Sentinel, SentinelInput } from '../../api/sentinels';
import { ColorDot } from '../board/OptionChip';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const models: { value: AgentModel; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet (padrão)' },
  { value: 'opus', label: 'Opus (tarefas difíceis)' },
  { value: 'haiku', label: 'Haiku (rápido e econômico)' },
];

const empty: SentinelInput = {
  name: '',
  isEnabled: true,
  fieldFilters: {},
  repositories: [],
  columnId: null,
  onlyUnassigned: true,
  instructions: '',
  model: 'sonnet',
  maxConcurrent: 1,
};

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** Toggle chips; none selected means "any". */
function ChipPicker({ options, selected, onChange }: {
  options: { id: string; name: string; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(toggle(selected, option.id))}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
              active ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted hover:text-white'
            }`}
          >
            {option.color && <ColorDot color={option.color} />}
            {option.name}
          </button>
        );
      })}
      {selected.length === 0 && <span className="self-center text-xs text-muted">qualquer</span>}
    </div>
  );
}

interface SentinelFormProps {
  board: Board;
  initial?: Sentinel;
  pending: boolean;
  error: Error | null;
  onSubmit: (input: SentinelInput) => void;
  onCancel: () => void;
}

export function SentinelForm({ board, initial, pending, error, onSubmit, onCancel }: SentinelFormProps) {
  const [form, setForm] = useState<SentinelInput>(initial ?? empty);
  const set = <K extends keyof SentinelInput>(key: K, value: SentinelInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const todoName = board.columns.find((column) => column.id === board.link.statusMap.todo)?.name;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">{initial ? `Editar sentinela "${initial.name}"` : 'Nova sentinela'}</h3>
      <p className="mt-1 text-xs text-muted">
        A cada atualização do quadro, a sentinela procura tarefas da coluna vigiada que batem com os filtros e lança um
        agente para cada uma, até o limite de agentes simultâneos. Você revisa e conclui o trabalho de cada agente.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Nome">
          <TextInput value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Ex.: Caçadora de bugs" required />
        </Field>
        <Field label="Coluna vigiada">
          <Select value={form.columnId ?? ''} onChange={(event) => set('columnId', event.target.value || null)}>
            <option value="">{todoName ? `${todoName} (coluna "A fazer" do quadro)` : 'Coluna "A fazer" do quadro'}</option>
            {board.columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Modelo">
            <Select value={form.model} onChange={(event) => set('model', event.target.value as AgentModel)}>
              {models.map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Agentes ao mesmo tempo">
            <Select value={form.maxConcurrent} onChange={(event) => set('maxConcurrent', Number(event.target.value))}>
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <h4 className="text-xs font-medium tracking-wider text-muted uppercase">Tipo de tarefa</h4>
        {board.fields.map((field) => (
          <div key={field.id} className="grid grid-cols-1 gap-1 md:grid-cols-[8rem_1fr] md:items-center">
            <span className="text-xs text-muted">{field.name}</span>
            <ChipPicker
              options={field.options}
              selected={form.fieldFilters[field.id] ?? []}
              onChange={(next) => set('fieldFilters', { ...form.fieldFilters, [field.id]: next })}
            />
          </div>
        ))}
        {board.repositories.length > 1 && (
          <div className="grid grid-cols-1 gap-1 md:grid-cols-[8rem_1fr] md:items-center">
            <span className="text-xs text-muted">Repositório</span>
            <ChipPicker
              options={board.repositories.map((repo) => ({ id: repo.path, name: repo.projectName }))}
              selected={form.repositories}
              onChange={(next) => set('repositories', next)}
            />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.onlyUnassigned} onChange={(event) => set('onlyUnassigned', event.target.checked)} />
          Só tarefas sem responsável
        </label>
      </div>

      <div className="mt-4">
        <Field label="Instruções extras para os agentes" hint="Enviadas junto com cada tarefa (ex.: padrões a seguir, o que testar, o que não mexer).">
          <textarea
            value={form.instructions}
            onChange={(event) => set('instructions', event.target.value)}
            rows={4}
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isEnabled} onChange={(event) => set('isEnabled', event.target.checked)} />
          Ativa
        </label>
        <Button type="submit" variant="primary" disabled={pending || !form.name.trim()}>
          {pending ? 'Salvando...' : 'Salvar sentinela'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
