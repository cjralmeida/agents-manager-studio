import { type ReactNode, useId, useState } from 'react';
import { Button } from './Button';

/**
 * A settings section that starts collapsed: title, description and a one-line summary of what is set; the full editor
 * opens with the button. For sections that grow with use (skills, variables).
 */
export function CollapsibleSection({
  title,
  description,
  summary,
  openLabel = 'Editar',
  children,
}: {
  title: string;
  description: ReactNode;
  /** What is set today, shown while collapsed. */
  summary: ReactNode;
  openLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted">{description}</p>
          {!open && <p className="mt-2 text-sm text-gray-300">{summary}</p>}
        </div>
        <Button size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={contentId}>
          {open ? 'Recolher' : openLabel}
        </Button>
      </div>
      {open && (
        <div id={contentId} className="mt-3">
          {children}
        </div>
      )}
    </section>
  );
}
