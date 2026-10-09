import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Extra text after the label, in the list only. */
  detail?: ReactNode;
}

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

  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  const chosen = options.filter((option) => selected.includes(option.value));

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
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul role="listbox" aria-multiselectable="true" className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg">
          {options.length === 0 && <li className="px-3 py-1.5 text-sm text-muted">Nenhuma opção.</li>}
          {options.map((option) => (
            <li key={option.value}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-border/60">
                <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />
                <span>{option.label}</span>
                {option.detail && <span className="truncate text-xs text-muted">{option.detail}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
