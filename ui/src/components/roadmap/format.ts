import type { DeliveryStatus, ProjectRoadmap, RoadmapDelivery, RoadmapTask, Schedule } from '../../api/roadmaps';

const DAY = 86_400_000;
const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "YYYY-MM-DD" as a UTC-noon instant, so day arithmetic never crosses a time-zone edge. */
export const dayMs = (day: string) => Date.parse(`${day}T12:00:00Z`);
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Local day of an ISO instant in a time zone. */
export function localDay(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
export const weekdayOf = (day: string) => weekdays[new Date(dayMs(day)).getUTCDay()]!;
export const longDay = (day: string) => `${weekdayOf(day)}, ${shortDay(day)}`;

export const usd = (value: number) => `US$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const number = (value: number, digits = 1) => value.toLocaleString('pt-BR', { maximumFractionDigits: digits });

export const statusLabels: Record<DeliveryStatus, { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  done: { label: 'Concluída', tone: 'success' },
  inProgress: { label: 'Em andamento', tone: 'info' },
  planned: { label: 'Planejada', tone: 'neutral' },
  notPlanned: { label: 'Sem tarefas', tone: 'neutral' },
};

export const scheduleLabels: Record<Schedule, { label: string; tone: 'success' | 'info' | 'warning' }> = {
  ahead: { label: 'Adiantada', tone: 'success' },
  onTime: { label: 'No prazo', tone: 'info' },
  late: { label: 'Atrasada', tone: 'warning' },
};

export const isFinished = (task: RoadmapTask) => task.isClosed || task.role === 'done';

export interface DeliverySpan {
  delivery: RoadmapDelivery;
  /** Local days, inclusive. */
  from: string;
  to: string;
  /** The end is a forecast (the delivery is not finished). */
  forecast: boolean;
}

/**
 * Where each delivery sits on the calendar: it starts on its planned start, or right after the previous one (the first,
 * at the start of the history); it ends when it finished, at its forecast, or at its deadline. Deliveries with no
 * dates and no pace to forecast are left out of the timeline.
 */
export function deliverySpans(project: ProjectRoadmap): DeliverySpan[] {
  const timeZone = project.metrics?.calendar.timeZone ?? 'America/Sao_Paulo';
  const today = localDay(new Date().toISOString(), timeZone);
  let cursor = project.metrics ? localDay(project.metrics.window.from, timeZone) : today;
  const spans: DeliverySpan[] = [];
  for (const delivery of project.roadmap ?? []) {
    const finished = delivery.actual.finishedAt ? localDay(delivery.actual.finishedAt, timeZone) : null;
    const forecast = delivery.forecast.end ? localDay(delivery.forecast.end, timeZone) : null;
    const end = finished ?? forecast ?? delivery.deadline;
    if (!end) continue;
    let from = delivery.start ?? (delivery.status === 'done' || delivery.status === 'inProgress' ? cursor : maxDay(cursor, today));
    if (from > end) from = end;
    spans.push({ delivery, from, to: end, forecast: !finished });
    cursor = dayOf(dayMs(end) + (finished ? 0 : DAY));
  }
  return spans;
}

export const maxDay = (a: string, b: string) => (a > b ? a : b);
export const minDay = (a: string, b: string) => (a < b ? a : b);
export const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY);
