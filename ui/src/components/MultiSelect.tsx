import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ColorDot } from './board/OptionChip';

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Extra text after the label, in the list only. */
  detail?: ReactNode;
  /** Board option color, shown as a dot. */
  color?: string;
  /** Options with a group are listed under its heading. */
  group?: string;
}

/** Lists longer than this get a search box. */
const SEARCH_FROM = 8;

/** A select that takes several values: looks like the other selects and opens a list with checkboxes. */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Nenhuma',
  disabled = false,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  const chosen = options.filter((option) => selected.includes(option.value));
  const term = search.trim().toLowerCase();
  const visible = term ? options.filter((option) => `${option.label} ${option.group ?? ''}`.toLowerCase().includes(term)) : options;
  const groups = [...new Set(visible.map((option) => option.group ?? ''))];

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-md border bg-surface px-2.5 py-1.5 text-left text-sm outline-none disabled:opacity-60 ${
          open ? 'border-accent' : 'border-border focus:border-accent'
        }`}
      >
        <span className={`truncate ${chosen.length === 0 ? 'text-muted' : ''}`}>
          {chosen.length === 0 ? placeholder : chosen.map((option) => option.label).join(', ')}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {chosen.length > 1 && <span className="rounded-full bg-border px-1.5 text-xs text-muted">{chosen.length}</span>}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-panel shadow-lg">
          {options.length > SEARCH_FROM && (
            <div className="border-b border-border p-1.5">
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar..."
                className="w-full rounded border border-border bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
              />
            </div>
          )}
          <ul role="listbox" aria-multiselectable="true" className="max-h-72 overflow-y-auto py-1">
            {visible.length === 0 && <li className="px-3 py-1.5 text-sm text-muted">Nenhuma opção.</li>}
            {groups.map((group) => (
              <li key={group}>
                {group && <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-muted uppercase">{group}</div>}
                <ul>
                  {visible
                    .filter((option) => (option.group ?? '') === group)
                    .map((option) => (
                      <li key={option.value}>
                        <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-border/60">
                          <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />
                          {option.color && <ColorDot color={option.color} />}
                          <span className="shrink-0">{option.label}</span>
                          {option.detail && <span className="truncate text-xs text-muted">{option.detail}</span>}
                        </label>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
          {selected.length > 0 && (
            <div className="flex justify-end border-t border-border px-2 py-1">
              <button type="button" onClick={() => onChange([])} className="text-xs text-muted hover:text-white">
                Limpar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
