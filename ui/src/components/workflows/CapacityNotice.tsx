import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type CapacitySuggestion, useCapacitySuggestions } from '../../api/capacity';
import { timeAgo } from '../../lib/time';

const DISMISSED_KEY = 'capacity-notice-dismissed';

function readDismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveDismissed(ids: string[]) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Without storage the notice just comes back on the next page load.
  }
}

/** Where a suggestion is decided: the Gestor de Capacidade section of the workspace's Workflows tab. */
export const capacityLink = (workspaceId: string) => `/workspaces/${workspaceId}?tab=workflows#gestor-capacidade`;

/**
 * Notice on every page while the Gestor de Capacidade waits for a decision; it opens the workspace where the
 * suggestion is applied or discarded. "Depois" hides it for this session (the workspace keeps its mark in the menu).
 */
export function CapacityNotice() {
  const suggestions = useCapacitySuggestions();
  const location = useLocation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);

  // The workspace's Workflows tab already shows the cards.
  const here = (suggestion: CapacitySuggestion) =>
    location.pathname === `/workspaces/${suggestion.workspaceId}` && new URLSearchParams(location.search).get('tab') === 'workflows';
  const visible = (suggestions.data ?? []).filter((suggestion) => !dismissed.includes(suggestion.id) && !here(suggestion));
  if (visible.length === 0) return null;

  const dismiss = () => {
    const next = [...dismissed, ...visible.map((suggestion) => suggestion.id)];
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <aside
      role="status"
      className="notice-rise fixed right-5 bottom-20 z-30 w-80 max-w-[calc(100vw-2.5rem)] rounded-lg border border-accent/60 bg-panel p-3 shadow-2xl"
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
        <p className="text-[11px] font-medium tracking-wider text-accent uppercase">Gestor de Capacidade</p>
      </div>
      <p className="mt-1 text-sm">
        {visible.length === 1 ? 'Tem uma sugestão esperando você:' : `Tem ${visible.length} sugestões esperando você:`}
      </p>
      <ul className="mt-2 space-y-1.5">
        {visible.slice(0, 3).map((suggestion) => (
          <li key={suggestion.id}>
            <button
              type="button"
              onClick={() => navigate(capacityLink(suggestion.workspaceId))}
              className="w-full rounded-md border border-border bg-surface/60 px-2.5 py-2 text-left hover:border-accent/60"
            >
              <span className="block text-sm">{suggestion.summary}</span>
              <span className="block text-xs text-muted">
                {suggestion.workspaceName} · {timeAgo(suggestion.createdAt)} · <span className="text-accent">Ver e decidir</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {visible.length > 3 && <p className="mt-1 text-xs text-muted">e mais {visible.length - 3}.</p>}
      <div className="mt-2 text-right">
        <button type="button" onClick={dismiss} className="text-xs text-muted hover:text-white">
          Depois
        </button>
      </div>
    </aside>
  );
}
