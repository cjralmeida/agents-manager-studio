import { useState } from 'react';
import type { SystemRoadmap } from '../../api/roadmaps';
import { type DeliverySpan, dayMs, dayOf, daysBetween, deliverySpans, localDay, longDay, maxDay, minDay, scheduleLabels, shortDay, statusLabels, usd } from './format';

const DAY = 86_400_000;

const barTone = {
  done: 'bg-emerald-400/80',
  inProgress: 'bg-accent/35',
  planned: 'bg-accent/35',
  notPlanned: 'bg-border',
} as const;

/**
 * The deliveries on the calendar, one row each: finished ones end when their last task closed, open ones at the
 * forecast (striped). A tick marks the planned deadline and a vertical line marks today.
 */
export function RoadmapTimeline({ project, onSelect }: { project: SystemRoadmap; onSelect: (number: number) => void }) {
  const [hovered, setHovered] = useState<{ span: DeliverySpan; x: number; y: number } | null>(null);
  const spans = deliverySpans(project);
  if (spans.length === 0) return null;

  const timeZone = project.metrics?.calendar.timeZone ?? 'America/Sao_Paulo';
  const today = localDay(new Date().toISOString(), timeZone);
  const deadlines = spans.flatMap((span) => (span.delivery.deadline ? [span.delivery.deadline] : []));
  const first = minDay(spans[0]!.from, today);
  const last = [today, ...deadlines, ...spans.map((span) => span.to)].reduce(maxDay);
  const total = daysBetween(first, last) + 1;
  const left = (day: string) => (daysBetween(first, day) / total) * 100;
  const width = (from: string, to: string) => ((daysBetween(from, to) + 1) / total) * 100;

  // Week starts (Mondays) for the header; with long roadmaps only every other label.
  const weeks: string[] = [];
  for (let at = dayMs(first); at <= dayMs(last); at += DAY) {
    const day = dayOf(at);
    // The first day gets a label too, unless a week starts within 3 days (the labels would overlap).
    const weekday = new Date(at).getUTCDay();
    if (weekday === 1 || (day === first && (8 - weekday) % 7 >= 3)) weeks.push(day);
  }
  const labelEvery = weeks.length > 14 ? 2 : 1;

  return (
    <section className="rounded-lg border border-border bg-panel p-4" aria-label="Linha do tempo das entregas">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <h3 className="mr-auto text-sm font-semibold text-gray-200">Linha do tempo</h3>
        <Legend className="bg-emerald-400/80" label="Concluída" />
        <Legend className="bg-accent" label="Feito" />
        <Legend className="bg-accent/35" label="A fazer" />
        <Legend className="forecast-stripes bg-accent/35" label="Previsão" />
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded bg-amber-400" aria-hidden /> Prazo
        </span>
      </div>

      <div className="relative">
        {/* Header: weeks */}
        <div className="relative ml-36 h-5 border-b border-border text-[10px] text-muted">
          {weeks.map((week, index) =>
            index % labelEvery === 0 ? (
              <span key={week} className="absolute top-0 whitespace-nowrap" style={{ left: `${left(week)}%` }}>
                {shortDay(week)}
              </span>
            ) : null,
          )}
        </div>

        <ol className="relative">
          {/* Week grid and today, behind the rows */}
          <div className="pointer-events-none absolute inset-y-0 right-0 left-36" aria-hidden>
            {weeks.map((week) => (
              <span key={week} className="absolute inset-y-0 w-px bg-border/60" style={{ left: `${left(week)}%` }} />
            ))}
            <span className="absolute inset-y-0 w-0.5 bg-fg/70" style={{ left: `${left(today) + width(today, today) / 2}%` }}>
              <span className="absolute -top-0.5 left-1 rounded bg-fg px-1 text-[10px] font-medium text-surface">hoje</span>
            </span>
          </div>

          {spans.map((span) => {
            const delivery = span.delivery;
            return (
              <li key={delivery.number} className="relative flex h-9 items-center">
                <button
                  type="button"
                  onClick={() => onSelect(delivery.number)}
                  className="w-36 shrink-0 truncate pr-3 text-left text-xs hover:text-accent"
                  title={`Entrega ${delivery.number} — ${delivery.name}`}
                >
                  <span className="text-muted">E{delivery.number}</span> {delivery.name || 'Sem nome'}
                </button>
                <div className="relative h-full flex-1">
                  <button
                    type="button"
                    aria-label={`Entrega ${delivery.number}: ${shortDay(span.from)} a ${shortDay(span.to)}`}
                    onClick={() => onSelect(delivery.number)}
                    onMouseMove={(event) => setHovered({ span, x: event.clientX, y: event.clientY })}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setHovered({ span, x: rect.left + rect.width / 2, y: rect.top });
                    }}
                    onBlur={() => setHovered(null)}
                    className="absolute top-1/2 h-4 -translate-y-1/2 py-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    style={{ left: `${left(span.from)}%`, width: `${width(span.from, span.to)}%`, minWidth: 6 }}
                  >
                    <span className={`block h-full rounded ${barTone[delivery.status]} ${span.forecast && delivery.status !== 'done' ? 'forecast-stripes' : ''}`}>
                      {delivery.progress.total > 0 && delivery.status !== 'done' && (
                        <span
                          className="block h-full rounded bg-accent"
                          style={{ width: `${Math.round((delivery.progress.done / delivery.progress.total) * 100)}%` }}
                        />
                      )}
                    </span>
                  </button>
                  {delivery.deadline && (
                    <span
                      className="pointer-events-none absolute top-1 bottom-1 w-0.5 rounded bg-amber-400"
                      style={{ left: `${left(delivery.deadline) + width(delivery.deadline, delivery.deadline)}%` }}
                      aria-hidden
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {hovered && <SpanTooltip span={hovered.span} x={hovered.x} y={hovered.y} />}
    </section>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-4 rounded-sm ${className}`} aria-hidden /> {label}
    </span>
  );
}

function SpanTooltip({ span, x, y }: { span: DeliverySpan; x: number; y: number }) {
  const { delivery } = span;
  const schedule = delivery.forecast.schedule ? scheduleLabels[delivery.forecast.schedule] : null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface p-2.5 text-xs shadow-lg"
      style={{ left: x, top: y - 10 }}
    >
      <p className="font-semibold">
        Entrega {delivery.number} — {delivery.name || 'Sem nome'}
      </p>
      <p className="mt-0.5 text-muted">
        {statusLabels[delivery.status].label}
        {schedule && ` · ${schedule.label}`}
      </p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted">Período</dt>
        <dd>
          {longDay(span.from)} → {longDay(span.to)}
          {span.forecast && delivery.status !== 'done' ? ' (previsto)' : ''}
        </dd>
        {delivery.deadline && (
          <>
            <dt className="text-muted">Prazo</dt>
            <dd>{longDay(delivery.deadline)}</dd>
          </>
        )}
        <dt className="text-muted">Tarefas</dt>
        <dd>
          {delivery.progress.done} de {delivery.progress.total || delivery.estimatedTasks || 0}
          {delivery.progress.total === 0 && delivery.estimatedTasks ? ' (previstas)' : ''}
        </dd>
        {delivery.actual.cost > 0 && (
          <>
            <dt className="text-muted">Custo até agora</dt>
            <dd>{usd(delivery.actual.cost)}</dd>
          </>
        )}
        {delivery.status !== 'done' && delivery.forecast.cost !== null && delivery.forecast.remainingTasks > 0 && (
          <>
            <dt className="text-muted">Custo restante</dt>
            <dd>{usd(delivery.forecast.cost)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
