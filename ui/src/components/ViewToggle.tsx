import { useState } from 'react';

export type View = 'cards' | 'table';

/** Card/table choice remembered per screen in this browser (a preference only, so failures are ignored). */
export function usePersistedView(key: string, fallback: View = 'cards') {
  const storageKey = `ams.view.${key}`;
  const [view, setView] = useState<View>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === 'cards' || stored === 'table' ? stored : fallback;
    } catch {
      return fallback;
    }
  });

  const change = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Preference only.
    }
  };
  return [view, change] as const;
}

export function ViewToggle({ view, onChange, cardsLabel = 'Cards' }: { view: View; onChange: (view: View) => void; cardsLabel?: string }) {
  return (
    <div className="flex rounded-md border border-border p-0.5">
      {(['cards', 'table'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${view === option ? 'bg-border text-white' : 'text-muted hover:text-white'}`}
        >
          {option === 'cards' ? cardsLabel : 'Tabela'}
        </button>
      ))}
    </div>
  );
}
