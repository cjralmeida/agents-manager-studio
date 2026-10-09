import { type DragEvent, useEffect, useRef, useState } from 'react';
import {
  type BoardColor,
  type BoardModel,
  type ModelColumn,
  type StatusRole,
  type StructureField,
  type StructureOption,
  boardColorLabels,
  boardColors,
  statusRoleLabels,
} from '../../api/boards';
import { Button } from '../Button';

const COLORS = Object.keys(boardColors) as BoardColor[];

/** Next palette color not used yet in the list, so new entries are told apart. */
function nextColor(used: StructureOption[]): BoardColor {
  return COLORS.find((color) => !used.some((option) => option.color === color)) ?? 'GRAY';
}

function move<T>(list: T[], from: number, to: number) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Native drag and drop to reorder a list. Only the handle (⠿) is draggable, so text in the inputs can still be
 * selected; the whole item (marked with data-drag-item) is shown while dragging. `group` keeps lists apart.
 */
function useReorder(group: string, onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const handle = (index: number) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.setData('text/plain', `${group}:${index}`);
      event.dataTransfer.effectAllowed = 'move';
      const item = event.currentTarget.closest('[data-drag-item]');
      if (item) event.dataTransfer.setDragImage(item, 16, 16);
      setDragging(index);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
  });
  const target = (index: number) => ({
    'data-drag-item': true,
    onDragOver: (event: DragEvent) => {
      if (dragging === null) return;
      event.preventDefault();
      setOver(index);
    },
    onDragLeave: () => setOver((value) => (value === index ? null : value)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const [source, from] = event.dataTransfer.getData('text/plain').split(':');
      if (source !== group) return;
      event.stopPropagation();
      if (from !== undefined && Number(from) !== index) onMove(Number(from), index);
      setDragging(null);
      setOver(null);
    },
  });
  return { handle, target, dragging, over };
}

function ColorPicker({ value, onChange }: { value: BoardColor; onChange: (color: BoardColor) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !container.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={container} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        title={`Cor: ${boardColorLabels[value]}`}
        className="flex size-6 items-center justify-center rounded-md border border-border hover:border-accent"
      >
        <span className="size-3.5 rounded-full" style={{ backgroundColor: boardColors[value] }} />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 grid w-max grid-cols-4 gap-1.5 rounded-md border border-border bg-panel p-2 shadow-lg">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={boardColorLabels[color]}
              onClick={() => {
                onChange(color);
                setOpen(false);
              }}
              className={`size-6 rounded-full border-2 ${color === value ? 'border-white' : 'border-transparent hover:border-muted'}`}
              style={{ backgroundColor: boardColors[color] }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const inputClasses = 'w-full rounded-md border border-border bg-surface px-2 py-1 text-sm outline-none focus:border-accent';

function CountBadge({ count, noun }: { count: number | undefined; noun: string }) {
  if (!count) return null;
  return (
    <span className="shrink-0 text-xs text-muted" title={`${count} ${noun} usam`}>
      {count} {count === 1 ? 'card' : 'cards'}
    </span>
  );
}

const ROLE_HINTS: Record<StatusRole, string> = {
  todo: 'Tarefas novas. No GitLab, as issues abertas sem coluna.',
  inProgress: 'Para onde a tarefa vai quando um agente é lançado.',
  review: 'Para onde a tarefa vai quando o PR/MR é aberto.',
  done: 'Concluídas. No GitLab, as issues fechadas.',
  blocked: 'Agentes não são lançados nestas tarefas.',
};

/**
 * Visual editor of the Studio board model: columns side by side (drag to reorder) with their agent role, then the
 * fields and their options. Counts show how many cards use each column/option, so removals are not a surprise.
 */
export function BoardStructureEditor({
  value,
  onChange,
  columnItems = {},
  optionItems = {},
}: {
  value: BoardModel;
  onChange: (next: BoardModel) => void;
  columnItems?: Record<string, number>;
  optionItems?: Record<string, Record<string, number>>;
}) {
  const setColumns = (columns: ModelColumn[]) => onChange({ ...value, columns });
  const setFields = (fields: StructureField[]) => onChange({ ...value, fields });
  const updateColumn = (index: number, patch: Partial<ModelColumn>) =>
    setColumns(value.columns.map((column, position) => (position === index ? { ...column, ...patch } : column)));
  /** A role belongs to one column: giving it to another takes it from the first. */
  const setRole = (index: number, role: StatusRole | null) =>
    setColumns(value.columns.map((column, position) => (position === index ? { ...column, role } : role && column.role === role ? { ...column, role: null } : column)));
  const columnDrag = useReorder('columns', (from, to) => setColumns(move(value.columns, from, to)));
  const fieldDrag = useReorder('fields', (from, to) => setFields(move(value.fields, from, to)));

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Colunas</h3>
        <p className="mt-1 text-xs text-muted">
          Arraste para reordenar e clique na bolinha para trocar a cor. Os papéis "A fazer" e "Concluído" são obrigatórios.
        </p>
        <div className="mt-3 flex items-stretch gap-3 overflow-x-auto pb-2">
          {value.columns.map((column, index) => (
            <div
              key={column.id ?? `new-${index}`}
              {...columnDrag.target(index)}
              className={`flex w-56 shrink-0 flex-col gap-2 rounded-lg border bg-panel p-3 ${
                columnDrag.over === index && columnDrag.dragging !== index ? 'border-accent' : 'border-border'
              } ${columnDrag.dragging === index ? 'opacity-50' : ''}`}
              style={{ borderTopColor: boardColors[column.color], borderTopWidth: 3 }}
            >
              <div className="flex items-center gap-2">
                <span {...columnDrag.handle(index)} className="cursor-grab text-muted select-none active:cursor-grabbing" title="Arraste para reordenar">
                  ⠿
                </span>
                <ColorPicker value={column.color} onChange={(color) => updateColumn(index, { color })} />
                <input
                  value={column.name}
                  onChange={(event) => updateColumn(index, { name: event.target.value })}
                  placeholder="Nome da coluna"
                  className={`${inputClasses} font-medium`}
                />
              </div>
              <textarea
                value={column.description}
                onChange={(event) => updateColumn(index, { description: event.target.value })}
                placeholder="Descrição (opcional)"
                rows={2}
                className={`${inputClasses} resize-none text-xs`}
              />
              <select
                value={column.role ?? ''}
                onChange={(event) => setRole(index, (event.target.value || null) as StatusRole | null)}
                title={column.role ? ROLE_HINTS[column.role] : 'Papel da coluna para os agentes'}
                className={`${inputClasses} text-xs ${column.role ? 'text-white' : 'text-muted'}`}
              >
                <option value="">Sem papel</option>
                {(Object.keys(statusRoleLabels) as StatusRole[]).map((role) => (
                  <option key={role} value={role}>
                    Papel: {statusRoleLabels[role]}
                  </option>
                ))}
              </select>
              <div className="mt-auto flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setColumns(move(value.columns, index, index - 1))}
                    disabled={index === 0}
                    className="rounded px-1 text-muted hover:text-white disabled:opacity-30"
                    title="Mover para a esquerda"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    onClick={() => setColumns(move(value.columns, index, index + 1))}
                    disabled={index === value.columns.length - 1}
                    className="rounded px-1 text-muted hover:text-white disabled:opacity-30"
                    title="Mover para a direita"
                  >
                    ▶
                  </button>
                  {column.id === null ? (
                    <span className="text-xs text-emerald-300">nova</span>
                  ) : (
                    <CountBadge count={columnItems[column.id]} noun="cards" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setColumns(value.columns.filter((_, position) => position !== index))}
                  className="text-xs text-muted hover:text-red-300"
                >
                  Remover
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setColumns([...value.columns, { id: null, name: '', color: nextColor(value.columns), description: '', role: null }])}
            className="flex w-40 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted hover:border-accent hover:text-white"
          >
            + Nova coluna
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Campos</h3>
        <p className="mt-1 text-xs text-muted">Campos de escolha única dos cards, como Prioridade e Tipo.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {value.fields.map((field, index) => (
            <div
              key={field.id ?? `new-${index}`}
              {...fieldDrag.target(index)}
              className={`rounded-lg border bg-panel p-3 ${fieldDrag.over === index && fieldDrag.dragging !== index ? 'border-accent' : 'border-border'} ${
                fieldDrag.dragging === index ? 'opacity-50' : ''
              }`}
            >
              <FieldEditor
                handle={fieldDrag.handle(index)}
                field={field}
                optionItems={field.id ? optionItems[field.id] : undefined}
                onChange={(next) => setFields(value.fields.map((entry, position) => (position === index ? next : entry)))}
                onRemove={() => setFields(value.fields.filter((_, position) => position !== index))}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setFields([...value.fields, { id: null, name: '', options: [{ id: null, name: '', color: 'GRAY', description: '' }] }])
            }
            className="min-h-24 rounded-lg border border-dashed border-border text-sm text-muted hover:border-accent hover:text-white"
          >
            + Novo campo
          </button>
        </div>
      </section>
    </div>
  );
}

function FieldEditor({
  handle,
  field,
  optionItems = {},
  onChange,
  onRemove,
}: {
  handle: ReturnType<ReturnType<typeof useReorder>['handle']>;
  field: StructureField;
  optionItems?: Record<string, number>;
  onChange: (next: StructureField) => void;
  onRemove: () => void;
}) {
  const setOptions = (options: StructureOption[]) => onChange({ ...field, options });
  const updateOption = (index: number, patch: Partial<StructureOption>) =>
    setOptions(field.options.map((option, position) => (position === index ? { ...option, ...patch } : option)));
  const drag = useReorder(`options-${field.id ?? field.name}`, (from, to) => setOptions(move(field.options, from, to)));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span {...handle} className="cursor-grab text-muted select-none active:cursor-grabbing" title="Arraste para reordenar os campos">
          ⠿
        </span>
        <input
          value={field.name}
          onChange={(event) => onChange({ ...field, name: event.target.value })}
          placeholder="Nome do campo"
          className={`${inputClasses} font-medium`}
        />
        {field.id === null && <span className="text-xs text-emerald-300">novo</span>}
        <Button size="sm" variant="danger" onClick={onRemove}>
          Remover campo
        </Button>
      </div>
      <ul className="space-y-1.5">
        {field.options.map((option, index) => (
          <li
            key={option.id ?? `new-${index}`}
            {...drag.target(index)}
            className={`flex items-center gap-2 rounded-md border px-1.5 py-1 ${drag.over === index && drag.dragging !== index ? 'border-accent' : 'border-transparent'} ${
              drag.dragging === index ? 'opacity-50' : ''
            }`}
          >
            <span {...drag.handle(index)} className="cursor-grab text-xs text-muted select-none active:cursor-grabbing" title="Arraste para reordenar">
              ⠿
            </span>
            <ColorPicker value={option.color} onChange={(color) => updateOption(index, { color })} />
            <input
              value={option.name}
              onChange={(event) => updateOption(index, { name: event.target.value })}
              placeholder="Opção"
              className={`${inputClasses} w-40 shrink-0`}
            />
            <input
              value={option.description}
              onChange={(event) => updateOption(index, { description: event.target.value })}
              placeholder="Descrição (opcional)"
              className={`${inputClasses} min-w-0 flex-1 text-xs`}
            />
            {option.id === null ? <span className="text-xs text-emerald-300">nova</span> : <CountBadge count={optionItems[option.id]} noun="cards" />}
            <button
              type="button"
              onClick={() => setOptions(field.options.filter((_, position) => position !== index))}
              disabled={field.options.length === 1}
              className="px-1 text-muted hover:text-red-300 disabled:opacity-30"
              title="Remover opção"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOptions([...field.options, { id: null, name: '', color: nextColor(field.options), description: '' }])}
        className="text-xs text-accent hover:underline"
      >
        + Opção
      </button>
    </div>
  );
}
