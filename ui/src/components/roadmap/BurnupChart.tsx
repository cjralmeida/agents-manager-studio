import { useMemo, useState } from 'react';
import type { SystemRoadmap } from '../../api/roadmaps';
import { dayMs, dayOf, daysBetween, localDay, longDay, number, shortDay } from './format';

const DAY = 86_400_000;
const WIDTH = 720;
const HEIGHT = 190;
const PAD = { top: 12, right: 16, bottom: 24, left: 36 };

interface Point {
  day: string;
  value: number;
  forecast: boolean;
  doneThatDay: number | null;
}

/**
 * Tasks finished over time (cumulative, from the project's history) and, from today, the forecast line up to the
 * whole remaining roadmap at the measured pace. One axis: tasks.
 */
export function BurnupChart({ project }: { project: SystemRoadmap }) {
  const [hover, setHover] = useState<number | null>(null);
  const metrics = project.metrics;
  const remaining = (project.roadmap ?? []).filter((delivery) => delivery.status !== 'done').reduce((sum, delivery) => sum + delivery.forecast.remainingTasks, 0);

  const points = useMemo<Point[]>(() => {
    if (!metrics) return [];
    let total = 0;
    const history = metrics.daily.map((entry) => {
      total += entry.done;
      return { day: entry.day, value: total, forecast: false, doneThatDay: entry.done };
    });
    const timeZone = metrics.calendar.timeZone;
    const end = project.forecastEnd ? localDay(project.forecastEnd, timeZone) : null;
    const today = history.at(-1);
    if (!end || !today || remaining === 0 || end <= today.day) return history;
    // Straight forecast line from today's total to the total with every remaining task done.
    const span = daysBetween(today.day, end);
    const future: Point[] = [];
    for (let step = 1; step <= span; step += 1) {
      future.push({ day: dayOf(dayMs(today.day) + step * DAY), value: today.value + (remaining * step) / span, forecast: true, doneThatDay: null });
    }
    return [...history, ...future];
  }, [metrics, project.forecastEnd, remaining]);

  if (!metrics || points.length < 2) return null;

  const max = Math.max(...points.map((point) => point.value), 1);
  const niceMax = Math.ceil(max / niceStep(max)) * niceStep(max);
  const x = (index: number) => PAD.left + (index / (points.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - value / niceMax) * (HEIGHT - PAD.top - PAD.bottom);
  const historyCount = points.filter((point) => !point.forecast).length;
  const path = (from: number, to: number) =>
    points
      .slice(from, to)
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(from + index).toFixed(1)},${y(point.value).toFixed(1)}`)
      .join(' ');
  const ticks = [0, niceMax / 2, niceMax];
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const hovered = hover === null ? null : points[hover]!;

  return (
    <section className="rounded-lg border border-border bg-panel p-4" aria-label="Tarefas concluídas e previsão">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <h3 className="mr-auto text-sm font-semibold text-gray-200">Tarefas concluídas no projeto</h3>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-accent" aria-hidden /> Realizado
        </span>
        {historyCount < points.length && (
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t-2 border-dashed border-accent/60" aria-hidden /> Previsão ({remaining} restantes)
          </span>
        )}
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${points[historyCount - 1]!.value} tarefas concluídas até hoje`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = ((event.clientX - rect.left) / rect.width) * WIDTH;
            const index = Math.round(((ratio - PAD.left) / (WIDTH - PAD.left - PAD.right)) * (points.length - 1));
            setHover(Math.min(points.length - 1, Math.max(0, index)));
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[10px]">
                {number(tick, 0)}
              </text>
            </g>
          ))}
          {points.map((point, index) =>
            index % labelEvery === 0 ? (
              <text key={point.day} x={x(index)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[10px]">
                {shortDay(point.day)}
              </text>
            ) : null,
          )}
          <path d={path(0, historyCount)} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {historyCount < points.length && (
            <path
              d={path(historyCount - 1, points.length)}
              fill="none"
              className="stroke-accent/60"
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinecap="round"
            />
          )}
          <circle cx={x(historyCount - 1)} cy={y(points[historyCount - 1]!.value)} r={4} className="fill-accent stroke-panel" strokeWidth={2} />
          {hovered && (
            <g>
              <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="stroke-muted" strokeWidth={1} />
              <circle cx={x(hover!)} cy={y(hovered.value)} r={4} className={hovered.forecast ? 'fill-panel stroke-accent' : 'fill-accent stroke-panel'} strokeWidth={2} />
            </g>
          )}
        </svg>
        {hovered && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow-lg"
            style={{ left: `${(x(hover!) / WIDTH) * 100}%`, transform: x(hover!) > WIDTH / 2 ? 'translateX(-105%)' : 'translateX(5%)' }}
          >
            <p className="font-medium">{longDay(hovered.day)}</p>
            <p className="text-muted">
              {hovered.forecast ? `Previsto: ${number(hovered.value, 0)} tarefas` : `${hovered.value} tarefas no total · ${hovered.doneThatDay} no dia`}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function niceStep(max: number) {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((candidate) => max / (candidate * magnitude) <= 4) ?? 10;
  return step * magnitude;
}
