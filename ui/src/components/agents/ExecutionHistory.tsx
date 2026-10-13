import { useState } from 'react';
import { Link } from 'react-router';
import type { Agent, AgentStatus } from '../../api/agents';
import { formatUsd } from '../../api/usage';
import { formatTime } from '../../lib/time';
import { AgentStatusBadge } from './AgentStatusBadge';

type Filter = 'all' | 'active' | 'waiting' | 'review' | 'done' | 'failed';

const FILTERS: { id: Filter; label: string; statuses: AgentStatus[] | null }[] = [
  { id: 'all', label: 'Todas', statuses: null },
  { id: 'active', label: 'Em andamento', statuses: ['PREPARING', 'RUNNING', 'FINALIZING'] },
  { id: 'waiting', label: 'Aguardando você', statuses: ['WAITING_INPUT'] },
  { id: 'review', label: 'Para revisar', statuses: ['READY_FOR_REVIEW'] },
  { id: 'done', label: 'Concluídas', statuses: ['COMPLETED'] },
  { id: 'failed', label: 'Falhas e canceladas', statuses: ['FAILED', 'CANCELLED'] },
];

const PAGE = 30;
const RUNNING: AgentStatus[] = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'FINALIZING'];

function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
}

/** Time from launch to finish (or until now / the last activity while not finished). */
function duration(agent: Agent) {
  const end = agent.finishedAt ?? (RUNNING.includes(agent.status) ? new Date().toISOString() : agent.lastActivityAt);
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(agent.createdAt).getTime()) / 60_000));
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Where the execution came from: a workflow, a board task, or launched by hand. */
function origin(agent: Agent) {
  if (agent.workflowName) return `workflow "${agent.workflowName}"`;
  if (agent.taskRef) return `tarefa ${agent.taskRef.split('/').at(-1)}`;
  return 'iniciada por você';
}

/** Executions of an agent grouped by day, newest first, with filters by situation. */
export function ExecutionHistory({ executions }: { executions: Agent[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);

  const statuses = FILTERS.find((entry) => entry.id === filter)?.statuses;
  const sorted = [...executions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = statuses ? sorted.filter((agent) => statuses.includes(agent.status)) : sorted;
  const shown = filtered.slice(0, limit);

  const groups: { day: string; items: Agent[] }[] = [];
  for (const agent of shown) {
    const day = dayLabel(agent.createdAt);
    const group = groups.at(-1);
    if (group?.day === day) group.items.push(agent);
    else groups.push({ day, items: [agent] });
  }
  const count = (entry: (typeof FILTERS)[number]) =>
    entry.statuses ? executions.filter((agent) => entry.statuses!.includes(agent.status)).length : executions.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((entry) => {
          const total = count(entry);
          if (entry.id !== 'all' && total === 0) return null;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setFilter(entry.id);
                setLimit(PAGE);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                filter === entry.id ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted hover:text-white'
              }`}
            >
              {entry.label} <span className="tabular-nums opacity-70">{total}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && <p className="text-sm text-muted">Nenhuma execução aqui.</p>}

      {groups.map((group) => (
        <section key={group.day}>
          <h3 className="mb-1 text-xs font-medium tracking-wider text-muted uppercase first-letter:uppercase">{group.day}</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {group.items.map((agent) => (
              <li
                key={agent.id}
                className={
                  agent.status === 'WAITING_INPUT'
                    ? 'bg-amber-400/5'
                    : !agent.paused && ['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status)
                      ? 'glow-working-row bg-purple-500/5'
                      : ''
                }
              >
                <Link to={`/agents/${agent.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-border/30">
                  <span className="w-36 shrink-0">
                    <AgentStatusBadge status={agent.status} paused={agent.paused} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{agent.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {origin(agent)}
                      {agent.projectName && ` · ${agent.projectName}`}
                    </span>
                  </span>
                  {agent.prUrl && (
                    <a
                      href={agent.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                      className="shrink-0 text-xs text-accent hover:underline"
                    >
                      PR/MR ↗
                    </a>
                  )}
                  <span className="shrink-0 text-xs text-muted tabular-nums">
                    {agent.usage.costUsd > 0 && `≈ ${formatUsd(agent.usage.costUsd)} · `}
                    {duration(agent)} · {formatTime(agent.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {filtered.length > limit && (
        <button type="button" onClick={() => setLimit((current) => current + PAGE)} className="text-sm text-accent hover:underline">
          Mostrar mais ({filtered.length - limit})
        </button>
      )}
    </div>
  );
}
