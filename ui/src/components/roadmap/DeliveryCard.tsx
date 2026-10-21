import { forwardRef, useEffect, useState } from 'react';
import type { RoadmapDay, RoadmapDelivery, RoadmapTask } from '../../api/roadmaps';
import { Badge } from '../Badge';
import { isFinished, localDay, longDay, number, scheduleLabels, shortDay, statusLabels, usd, weekdayOf } from './format';

/** One delivery: status, dates, cost, how far each project is, the goal of each day, and its tasks by area. */
export const DeliveryCard = forwardRef<
  HTMLLIElement,
  { delivery: RoadmapDelivery; highlighted: boolean; forceOpen: boolean; timeZoneEnd: string | null; timeZone: string }
>(function DeliveryCard({ delivery, highlighted, forceOpen, timeZoneEnd, timeZone }, ref) {
  // The current delivery opens with its plan; finished and future ones stay compact.
  const [open, setOpen] = useState(highlighted);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const status = statusLabels[delivery.status];
  const schedule = delivery.forecast.schedule ? scheduleLabels[delivery.forecast.schedule] : null;
  const total = delivery.progress.total || delivery.estimatedTasks || 0;
  const percent = total > 0 ? Math.round((delivery.progress.done / total) * 100) : 0;
  const areas = groupByArea(delivery.tasks);

  return (
    <li ref={ref} className={`rounded-lg border bg-panel ${highlighted ? 'border-accent/50' : 'border-border'}`}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="w-full p-4 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium tracking-wider text-accent uppercase">Entrega {delivery.number}</span>
          <h3 className="text-sm font-semibold">{delivery.name || 'Sem nome'}</h3>
          <Badge tone={status.tone}>{status.label}</Badge>
          {schedule && <Badge tone={schedule.tone}>{schedule.label}</Badge>}
          <span className="ml-auto text-xs text-muted">{open ? 'Recolher' : 'Ver plano'}</span>
        </div>
        {delivery.objective && <p className="mt-1 text-sm text-gray-300">{plain(delivery.objective)}</p>}

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Fact label="Período" value={dateRange(delivery)} />
          <Fact
            label={delivery.status === 'done' ? 'Concluída em' : 'Previsão'}
            value={timeZoneEnd ? longDay(timeZoneEnd) : delivery.status === 'done' ? '—' : 'sem ritmo medido'}
          />
          <Fact label="Custo" value={costText(delivery)} />
          <Fact label="Horas de agente" value={delivery.actual.agentHours > 0 ? `${number(delivery.actual.agentHours)} h` : '—'} />
        </div>

        {total > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
              <div className={`h-full rounded-full ${delivery.status === 'done' ? 'bg-emerald-400' : 'bg-accent'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs whitespace-nowrap text-muted">
              {delivery.progress.done} de {total} tarefas{delivery.progress.total === 0 ? ' previstas' : ''}
            </span>
          </div>
        )}
        {delivery.lanes.length > 1 && <Lanes delivery={delivery} timeZone={timeZone} />}
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {delivery.days.length > 0 && <DayPlan days={delivery.days} />}
          <div className="grid gap-3 md:grid-cols-3">
            <TextBlock title="Escopo" text={delivery.scope} />
            <TextBlock title="Fora do escopo" text={delivery.outOfScope} />
            <TextBlock title="Critérios de pronto" text={delivery.doneCriteria} />
          </div>
          {delivery.notes && <TextBlock title="Notas" text={delivery.notes} />}
          {areas.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {areas.map(([area, tasks]) => (
                <section key={area}>
                  <h4 className="text-xs font-medium text-gray-300">
                    {area} <span className="text-muted">· {tasks.filter(isFinished).length}/{tasks.length}</span>
                  </h4>
                  <TaskList tasks={tasks} />
                </section>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">
              Nenhuma tarefa no quadro com <span className="font-mono">Entrega: {delivery.number}</span> ainda.
            </p>
          )}
          {delivery.planningTask && (
            <p className="text-xs text-muted">
              Planejamento: <TaskLink task={delivery.planningTask} /> ({delivery.planningTask.column ?? 'fora do quadro'})
            </p>
          )}
        </div>
      )}
    </li>
  );
});

/** Each project's part of the delivery (e.g. the API and the front), with when it is forecast to finish: the slowest one sets the end. */
function Lanes({ delivery, timeZone }: { delivery: RoadmapDelivery; timeZone: string }) {
  const ends = delivery.lanes.flatMap((lane) => (lane.end && lane.done < lane.total ? [lane.end] : []));
  const last = ends.length > 1 ? ends.reduce((a, b) => (a > b ? a : b)) : null;
  return (
    <ul className="mt-2 grid gap-1.5 sm:grid-cols-2" aria-label="Andamento por projeto">
      {delivery.lanes.map((lane) => {
        const done = lane.done === lane.total;
        const percent = Math.round((lane.done / lane.total) * 100);
        return (
          <li key={lane.projectId} className="flex items-center gap-2 text-[11px]">
            <span className="w-28 truncate text-gray-300" title={lane.projectName}>
              {lane.projectName}
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
              <div className={`h-full rounded-full ${done ? 'bg-emerald-400' : 'bg-accent/70'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="whitespace-nowrap text-muted tabular-nums">
              {lane.done}/{lane.total}
            </span>
            <span className={`w-24 text-right whitespace-nowrap ${lane.end === last ? 'text-amber-300' : 'text-muted'}`} title={lane.end === last ? 'Este projeto define o fim da entrega' : undefined}>
              {done ? 'pronto' : lane.end ? `até ${shortDay(localDay(lane.end, timeZone))}` : '—'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Markdown emphasis markers out of a text shown as is. */
const plain = (text: string) => text.replace(/\*\*/g, '');

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted">{label}</p>
      <p className="font-medium text-gray-200">{value}</p>
    </div>
  );
}

function dateRange(delivery: RoadmapDelivery) {
  if (delivery.start && delivery.deadline) return `${shortDay(delivery.start)} → ${shortDay(delivery.deadline)}`;
  if (delivery.deadline) return `até ${shortDay(delivery.deadline)}`;
  if (delivery.start) return `desde ${shortDay(delivery.start)}`;
  return 'sem datas planejadas';
}

function costText(delivery: RoadmapDelivery) {
  if (delivery.status === 'done') return delivery.actual.cost > 0 ? usd(delivery.actual.cost) : '—';
  const spent = delivery.actual.cost > 0 ? usd(delivery.actual.cost) : null;
  const left = delivery.forecast.cost !== null && delivery.forecast.remainingTasks > 0 ? `+ ${usd(delivery.forecast.cost)}` : null;
  return [spent, left].filter(Boolean).join(' ') || '—';
}

const dayTone = {
  done: { dot: 'bg-emerald-400', label: 'Feito', text: 'text-emerald-300' },
  late: { dot: 'bg-amber-400', label: 'Atrasado', text: 'text-amber-300' },
  today: { dot: 'bg-accent', label: 'Hoje', text: 'text-accent' },
  upcoming: { dot: 'bg-border', label: 'A seguir', text: 'text-muted' },
} as const;

/** The plan day by day: each day's goal and the tasks that close it. */
function DayPlan({ days }: { days: RoadmapDay[] }) {
  return (
    <section>
      <h4 className="text-xs font-medium text-gray-300">Plano por dia</h4>
      <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {days.map((day) => {
          const tone = dayTone[day.status];
          return (
            <li key={`${day.date}-${day.goal}`} className={`rounded-md border p-2.5 ${day.status === 'today' ? 'border-accent/60' : 'border-border'}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
                <span className="font-medium capitalize">
                  {weekdayOf(day.date)} {shortDay(day.date)}
                </span>
                <span className={`ml-auto ${tone.text}`}>{tone.label}</span>
              </div>
              <p className="mt-1 text-xs text-gray-300">{day.goal}</p>
              {day.tasks.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1">
                  {day.tasks.map((task) => {
                    const label = task.ref.slice(task.ref.lastIndexOf('/') + 1);
                    const classes = `rounded px-1.5 py-0.5 text-[11px] ${task.done ? 'bg-emerald-500/15 text-emerald-300 line-through decoration-emerald-300/50' : 'bg-border text-muted'}`;
                    return (
                      <li key={task.ref}>
                        {task.url ? (
                          <a href={task.url} target="_blank" rel="noreferrer" className={`${classes} hover:text-accent`} title={task.title ?? task.ref}>
                            {label}
                          </a>
                        ) : (
                          <span className={classes} title={task.title ?? task.ref}>
                            {label}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <section>
      <h4 className="text-xs font-medium text-gray-300">{title}</h4>
      <p className="mt-0.5 text-xs whitespace-pre-line text-muted">{plain(text)}</p>
    </section>
  );
}

const roleDot: Record<string, string> = {
  done: 'bg-emerald-400',
  homologation: 'bg-sky-400',
  review: 'bg-purple-400',
  inProgress: 'bg-amber-400',
  blocked: 'bg-red-400',
  todo: 'bg-border',
};

export function TaskList({ tasks }: { tasks: RoadmapTask[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${task.isClosed ? roleDot.done : roleDot[task.role ?? 'todo']}`}
            title={task.isClosed ? 'Fechada' : (task.column ?? 'Fora do quadro')}
            aria-hidden
          />
          <TaskLink task={task} />
          <span className="ml-auto whitespace-nowrap text-muted">{task.isClosed ? 'Fechada' : task.column}</span>
        </li>
      ))}
    </ul>
  );
}

function TaskLink({ task }: { task: RoadmapTask }) {
  const label = `${task.number ? `#${task.number} ` : ''}${task.title.replace(/^\[[^\]]+\]\s*/, '')}`;
  return task.url ? (
    <a href={task.url} target="_blank" rel="noreferrer" className="truncate hover:text-accent" title={task.title}>
      {label}
    </a>
  ) : (
    <span className="truncate" title={task.title}>
      {label}
    </span>
  );
}

function groupByArea(tasks: RoadmapTask[]) {
  const groups = new Map<string, RoadmapTask[]>();
  for (const task of tasks) groups.set(task.area ?? 'Sem área', [...(groups.get(task.area ?? 'Sem área') ?? []), task]);
  return [...groups.entries()];
}
