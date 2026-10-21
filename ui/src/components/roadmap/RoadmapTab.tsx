import { useRef, useState } from 'react';
import type { WorkspaceDetail } from '../../api/workspaces';
import { type SystemRoadmap, useRefreshRoadmaps, useRoadmaps } from '../../api/roadmaps';
import { Button } from '../Button';
import { BurnupChart } from './BurnupChart';
import { DeliveryCard, TaskList } from './DeliveryCard';
import { RoadmapSettingsPanel } from './RoadmapSettingsPanel';
import { RoadmapTimeline } from './RoadmapTimeline';
import { SystemsPanel } from './SystemsPanel';
import { daysBetween, localDay, longDay, number, usd } from './format';

/**
 * Roadmap of each system (a product made of one or more projects): the deliveries of its roadmap.md, in the system's
 * docs home, on a timeline, the plan day by day, how far each one is (board tasks with "Entrega: N", by project), and
 * the forecast from the pace each project's history shows (pauses cut out). Everything is read live; the roadmap itself
 * is written by the roadmap planner agent.
 */
export function RoadmapTab({ workspace }: { workspace: WorkspaceDetail }) {
  const roadmaps = useRoadmaps(workspace.id);
  const refresh = useRefreshRoadmaps(workspace.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [systemsOpen, setSystemsOpen] = useState(false);

  if (roadmaps.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (roadmaps.error) return <p className="text-sm text-red-300">{roadmaps.error.message}</p>;

  const systems = roadmaps.data;
  if (systems.length === 0) return <p className="text-sm text-muted">Este workspace não tem projetos.</p>;
  // Systems with a roadmap first, then the configured ones (dimmed); a lone project without a roadmap only shows when
  // there is nothing else.
  const withRoadmap = systems.filter((system) => system.roadmap);
  const configured = systems.filter((system) => !system.roadmap && !system.implicit);
  const shown = withRoadmap.length + configured.length > 0 ? [...withRoadmap, ...configured] : systems;
  const hidden = systems.length - shown.length;
  const current = shown.find((system) => system.systemId === selected) ?? shown[0]!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Sistemas">
          {shown.map((system) => {
            const active = system.systemId === current.systemId;
            return (
              <button
                key={system.systemId}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelected(system.systemId)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  active ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted hover:text-white'
                } ${system.roadmap ? '' : 'opacity-60'}`}
                title={[system.projects.map((project) => project.projectName).join(' + '), system.roadmap ? null : 'sem roadmap'].filter(Boolean).join(' · ')}
              >
                {system.systemName}
                {system.roadmap && <span className="ml-1.5 text-muted">{system.roadmap.length}</span>}
              </button>
            );
          })}
          {hidden > 0 && <span className="text-[11px] text-muted">+{hidden} projeto(s) sem roadmap</span>}
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setSystemsOpen((open) => !open)} aria-expanded={systemsOpen}>
            Sistemas
          </Button>
          <Button size="sm" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
            Calendário e pausas
          </Button>
          <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending ? 'Atualizando...' : 'Atualizar'}
          </Button>
        </div>
      </div>
      {systemsOpen && <SystemsPanel workspace={workspace} onClose={() => setSystemsOpen(false)} />}
      {settingsOpen && <RoadmapSettingsPanel workspaceId={workspace.id} onClose={() => setSettingsOpen(false)} />}
      <SystemRoadmapView key={current.systemId} project={current} />
    </div>
  );
}

function SystemRoadmapView({ project }: { project: SystemRoadmap }) {
  const [focused, setFocused] = useState<number | null>(null);
  const cards = useRef(new Map<number, HTMLLIElement>());
  if (!project.roadmap) return <EmptyRoadmap project={project} />;
  const deliveries = project.roadmap;
  const current = deliveries.find((delivery) => delivery.status !== 'done');
  const timeZone = project.metrics?.calendar.timeZone ?? 'America/Sao_Paulo';

  const select = (number: number) => {
    setFocused(number);
    cards.current.get(number)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-4">
      <Summary project={project} />
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted">
          O arquivo existe, mas nenhuma entrega foi reconhecida. Use títulos no formato <span className="font-mono">## Entrega 1 — Nome</span>.
        </p>
      ) : (
        <>
          <RoadmapTimeline project={project} onSelect={select} />
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <BurnupChart project={project} />
            <PacePanel project={project} />
          </div>
          <ol className="space-y-3">
            {deliveries.map((delivery) => {
              const end = delivery.actual.finishedAt ?? delivery.forecast.end;
              return (
                <DeliveryCard
                  key={delivery.number}
                  ref={(element) => {
                    if (element) cards.current.set(delivery.number, element);
                  }}
                  delivery={delivery}
                  highlighted={delivery.number === current?.number}
                  forceOpen={focused === delivery.number}
                  timeZoneEnd={end ? localDay(end, timeZone) : null}
                  timeZone={timeZone}
                />
              );
            })}
          </ol>
        </>
      )}
      {project.orphanTasks.length > 0 && (
        <section className="rounded-lg border border-amber-500/30 p-3">
          <p className="text-xs text-amber-300">Tarefas com uma entrega que o roadmap não tem:</p>
          <TaskList tasks={project.orphanTasks} />
        </section>
      )}
      <p className="text-[11px] text-muted">
        Lido de{' '}
        <span className="font-mono">
          {project.docsProjectName}/{project.file}
        </span>{' '}
        ({project.source === 'remote' ? 'branch principal no remoto' : 'pasta local'})
        {project.projects.length > 1 ? `, com as tarefas de ${project.projects.map((entry) => entry.projectName).join(' e ')}` : ''}. Custos estimados a preço de
        API.
      </p>
    </div>
  );
}

/** The headline numbers: when it ends, how fast it goes, what is left to spend. */
function Summary({ project }: { project: SystemRoadmap }) {
  const deliveries = project.roadmap ?? [];
  const done = deliveries.filter((delivery) => delivery.status === 'done').length;
  const metrics = project.metrics;
  const timeZone = metrics?.calendar.timeZone ?? 'America/Sao_Paulo';
  const today = localDay(new Date().toISOString(), timeZone);
  const end = project.forecastEnd ? localDay(project.forecastEnd, timeZone) : null;
  const unit = metrics && metrics.hoursPerWorkingDay < 24 ? 'dia útil' : 'dia';
  const spent = deliveries.reduce((sum, delivery) => sum + delivery.actual.cost, 0);

  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label="Previsão de conclusão"
        value={end ? longDay(end) : done === deliveries.length && deliveries.length > 0 ? 'Concluído' : '—'}
        hint={end ? `em ${daysBetween(today, end)} dia(s) corrido(s)` : metrics?.tasksPerDay ? 'entregas sem tarefas para prever' : 'sem ritmo medido ainda'}
      />
      <Tile
        label="Ritmo"
        value={metrics?.tasksPerDay ? `${number(metrics.tasksPerDay)} tarefas/${unit}` : '—'}
        hint={metrics ? `${metrics.tasksDone} tarefas em ${number(metrics.productiveHours / metrics.hoursPerWorkingDay)} ${unit === 'dia' ? 'dias' : 'dias úteis'} de trabalho efetivo` : undefined}
      />
      <Tile
        label="Custo por tarefa"
        value={metrics?.costPerTask !== null && metrics?.costPerTask !== undefined ? usd(metrics.costPerTask) : '—'}
        hint={metrics?.agentHoursPerTask ? `${number(metrics.agentHoursPerTask)} h de agente por tarefa` : 'sem agentes nas tarefas'}
      />
      <Tile
        label="Entregas"
        value={`${done} de ${deliveries.length}`}
        hint={[spent > 0 ? `${usd(spent)} gastos` : null, project.remainingCost ? `${usd(project.remainingCost)} a gastar` : null].filter(Boolean).join(' · ') || undefined}
      />
    </dl>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
      {hint && <dd className="mt-0.5 text-[11px] text-muted">{hint}</dd>}
    </div>
  );
}

/** Where the pace comes from: effort by area and the time cut out as pauses. */
function PacePanel({ project }: { project: SystemRoadmap }) {
  const metrics = project.metrics;
  if (!metrics) return null;
  const unit = metrics.hoursPerWorkingDay < 24 ? 'dias úteis' : 'dias';
  return (
    <section className="space-y-3 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-semibold">De onde vem o ritmo</h3>
      <p className="text-xs text-muted">
        Histórico desde {longDay(localDay(metrics.window.from, metrics.calendar.timeZone))}: {number(metrics.productiveHours / metrics.hoursPerWorkingDay)} {unit} de
        trabalho efetivo. Foram cortadas {number(metrics.pauses.pausedHours, 0)} h de pausa ({metrics.pauses.auto.length} sem nada rodando
        {metrics.pauses.manual.length > 0 ? `, ${metrics.pauses.manual.length} marcadas` : ''}).
        {metrics.bulkClosed > 0 && ` ${metrics.bulkClosed} tarefa(s) fechada(s) em lote, sem agente, ficaram fora do ritmo.`}
      </p>
      {metrics.error && <p className="text-xs text-amber-300">{metrics.error}</p>}
      {project.projects.length > 1 && (
        <table className="w-full text-xs">
          <caption className="sr-only">Ritmo por projeto</caption>
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-normal">Projeto</th>
              <th className="py-1 text-right font-normal">Tarefas</th>
              <th className="py-1 text-right font-normal">Ritmo</th>
              <th className="py-1 text-right font-normal">Custo/tarefa</th>
            </tr>
          </thead>
          <tbody>
            {project.projects.map(({ projectId, projectName, metrics: own }) => (
              <tr key={projectId} className="border-t border-border">
                <td className="py-1">{projectName}</td>
                <td className="py-1 text-right tabular-nums">{own?.tasksDone ?? '—'}</td>
                <td className="py-1 text-right tabular-nums">{own?.tasksPerDay ? `${number(own.tasksPerDay)}/${unit === 'dias' ? 'dia' : 'dia útil'}` : '—'}</td>
                <td className="py-1 text-right tabular-nums">{own?.costPerTask ? usd(own.costPerTask) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {metrics.byArea.length > 0 && (
        <table className="w-full text-xs">
          <caption className="sr-only">Esforço por área</caption>
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-normal">Área</th>
              <th className="py-1 text-right font-normal">Tarefas</th>
              <th className="py-1 text-right font-normal">Custo/tarefa</th>
              <th className="py-1 text-right font-normal">Horas/tarefa</th>
            </tr>
          </thead>
          <tbody>
            {metrics.byArea.map((area) => (
              <tr key={area.area} className="border-t border-border">
                <td className="py-1">{area.area}</td>
                <td className="py-1 text-right tabular-nums">{area.tasks}</td>
                <td className="py-1 text-right tabular-nums">{area.costPerTask > 0 ? usd(area.costPerTask) : '—'}</td>
                <td className="py-1 text-right tabular-nums">{area.agentHoursPerTask > 0 ? `${number(area.agentHoursPerTask)} h` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EmptyRoadmap({ project }: { project: SystemRoadmap }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-4 text-sm">
      <p>
        <span className="font-medium">{project.systemName}</span> ainda não tem roadmap.
      </p>
      {project.error && <p className="text-xs text-amber-300">Não foi possível ler o remoto: {project.error}</p>}
      <p className="text-xs text-muted">
        Peça ao Órbi para montar o roadmap deste sistema (o agente planejador de roadmap escreve{' '}
        <span className="font-mono">
          {project.docsProjectName}/{project.file}
        </span>{' '}
        com as entregas semanais e as metas de cada dia), ou crie o arquivo na branch principal. Nas tarefas do quadro, a linha <span className="font-mono">Entrega: N</span> liga cada
        tarefa à sua entrega.
      </p>
      <pre className="overflow-x-auto rounded bg-surface p-3 text-[11px] text-gray-300">
        {`# Roadmap

## Entrega 1 — Nome curto
**Objetivo:** o que fica pronto e utilizável no fim dela.
**Escopo:** o que entra.
**Fora do escopo:** o que fica para depois.
**Critérios de pronto:** como saber que terminou.
**Início:** 2026-10-22
**Prazo:** 2026-10-28
**Dias:**
- 2026-10-22 — meta do dia: repo#12, repo#13
- 2026-10-23 — ...`}
      </pre>
    </div>
  );
}
