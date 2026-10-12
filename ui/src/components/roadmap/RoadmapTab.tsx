import { useState } from 'react';
import type { WorkspaceDetail } from '../../api/workspaces';
import { type DeliveryStatus, type ProjectRoadmap, type RoadmapDelivery, type RoadmapTask, useRoadmaps } from '../../api/roadmaps';
import { Badge } from '../Badge';

/**
 * Roadmap of each project: the deliveries of its docs/roadmap.md and how far each one is, from the board tasks that
 * carry "Entrega: N". Everything is read live; nothing here is edited.
 */
export function RoadmapTab({ workspace }: { workspace: WorkspaceDetail }) {
  const roadmaps = useRoadmaps(workspace.id);
  const [selected, setSelected] = useState<string | null>(null);

  if (roadmaps.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (roadmaps.error) return <p className="text-sm text-red-300">{roadmaps.error.message}</p>;

  const projects = roadmaps.data;
  if (projects.length === 0) return <p className="text-sm text-muted">Este workspace não tem projetos.</p>;
  const withRoadmap = projects.filter((project) => project.roadmap);
  const current = projects.find((project) => project.projectId === selected) ?? withRoadmap[0] ?? projects[0]!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Projetos">
        {projects.map((project) => {
          const active = project.projectId === current.projectId;
          return (
            <button
              key={project.projectId}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelected(project.projectId)}
              className={`rounded-full border px-3 py-1 text-xs ${
                active ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted hover:text-white'
              } ${project.roadmap ? '' : 'opacity-60'}`}
              title={project.roadmap ? undefined : 'Sem roadmap'}
            >
              {project.projectName}
              {project.roadmap && <span className="ml-1.5 text-muted">{project.roadmap.length}</span>}
            </button>
          );
        })}
      </div>
      <ProjectRoadmapView project={current} />
    </div>
  );
}

function ProjectRoadmapView({ project }: { project: ProjectRoadmap }) {
  if (!project.roadmap) return <EmptyRoadmap project={project} />;
  const deliveries = project.roadmap;
  const done = deliveries.filter((delivery) => delivery.status === 'done').length;
  const current = deliveries.find((delivery) => delivery.status !== 'done');

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {deliveries.length === 1 ? '1 entrega' : `${deliveries.length} entregas`} · {done} concluída(s)
        {current && <> · agora: Entrega {current.number}{current.name && ` — ${current.name}`}</>} · lido de{' '}
        <span className="font-mono">{project.file}</span> ({project.source === 'remote' ? 'branch base no remoto' : 'pasta local'})
      </p>
      {deliveries.length === 0 && (
        <p className="text-sm text-muted">
          O arquivo existe, mas nenhuma entrega foi reconhecida. Use títulos no formato <span className="font-mono">## Entrega 1 — Nome</span>.
        </p>
      )}
      <ol className="space-y-3">
        {deliveries.map((delivery) => (
          <DeliveryCard key={delivery.number} delivery={delivery} highlighted={delivery.number === current?.number} />
        ))}
      </ol>
      {project.orphanTasks.length > 0 && (
        <section className="rounded-lg border border-amber-500/30 p-3">
          <p className="text-xs text-amber-300">Tarefas com uma entrega que o roadmap não tem:</p>
          <TaskList tasks={project.orphanTasks} />
        </section>
      )}
    </div>
  );
}

const statusLabels: Record<DeliveryStatus, { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  done: { label: 'Concluída', tone: 'success' },
  inProgress: { label: 'Em andamento', tone: 'info' },
  planned: { label: 'Planejada', tone: 'neutral' },
  notPlanned: { label: 'Sem tarefas', tone: 'neutral' },
};

function DeliveryCard({ delivery, highlighted }: { delivery: RoadmapDelivery; highlighted: boolean }) {
  // The current delivery opens with its tasks; finished and future ones stay compact.
  const [open, setOpen] = useState(highlighted);
  const status = statusLabels[delivery.status];
  const percent = delivery.progress.total > 0 ? Math.round((delivery.progress.done / delivery.progress.total) * 100) : 0;
  const areas = groupByArea(delivery.tasks);

  return (
    <li className={`rounded-lg border bg-panel p-4 ${highlighted ? 'border-accent/50' : 'border-border'}`}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="w-full text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium tracking-wider text-accent uppercase">Entrega {delivery.number}</span>
          <h3 className="text-sm font-semibold">{delivery.name || 'Sem nome'}</h3>
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="ml-auto text-xs text-muted">{open ? 'Recolher' : 'Ver detalhes'}</span>
        </div>
        {delivery.objective && <p className="mt-1 text-sm text-gray-300">{delivery.objective}</p>}
        {delivery.progress.total > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
              <div className={`h-full rounded-full ${delivery.status === 'done' ? 'bg-emerald-400' : 'bg-accent'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs whitespace-nowrap text-muted">
              {delivery.progress.done} de {delivery.progress.total} tarefas
            </span>
          </div>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
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
              Planejamento:{' '}
              <TaskLink task={delivery.planningTask} /> ({delivery.planningTask.column ?? 'fora do quadro'})
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <section>
      <h4 className="text-xs font-medium text-gray-300">{title}</h4>
      <p className="mt-0.5 text-xs whitespace-pre-line text-muted">{text}</p>
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

function TaskList({ tasks }: { tasks: RoadmapTask[] }) {
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

const isFinished = (task: RoadmapTask) => task.isClosed || task.role === 'done';

function groupByArea(tasks: RoadmapTask[]) {
  const groups = new Map<string, RoadmapTask[]>();
  for (const task of tasks) groups.set(task.area ?? 'Sem área', [...(groups.get(task.area ?? 'Sem área') ?? []), task]);
  return [...groups.entries()];
}

function EmptyRoadmap({ project }: { project: ProjectRoadmap }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-4 text-sm">
      <p>
        <span className="font-medium">{project.projectName}</span> ainda não tem roadmap.
      </p>
      {project.error && <p className="text-xs text-amber-300">Não foi possível ler o remoto: {project.error}</p>}
      <p className="text-xs text-muted">
        Crie <span className="font-mono">{project.file}</span> no repositório (na branch base) com as entregas em ordem, ou peça ao Órbi para montar um a
        partir do que o projeto precisa. Nas tarefas do quadro, a linha <span className="font-mono">Entrega: N</span> liga cada tarefa à sua entrega.
      </p>
      <pre className="overflow-x-auto rounded bg-surface p-3 text-[11px] text-gray-300">
        {`# Roadmap

## Entrega 1 — Nome curto
**Objetivo:** o que fica pronto e utilizável no fim dela.
**Escopo:** o que entra.
**Fora do escopo:** o que fica para depois.
**Critérios de pronto:** como saber que terminou.`}
      </pre>
    </div>
  );
}
