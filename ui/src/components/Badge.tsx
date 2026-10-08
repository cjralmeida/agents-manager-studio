import type { ReactNode } from 'react';

type Tone = 'neutral' | 'warning' | 'info' | 'success' | 'danger';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-border text-muted',
  warning: 'bg-amber-500/15 text-amber-300',
  info: 'bg-accent/15 text-accent',
  success: 'bg-emerald-500/15 text-emerald-300',
  danger: 'bg-red-500/15 text-red-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}
