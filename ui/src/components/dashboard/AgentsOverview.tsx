import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Agent } from '../../api/agents';
import { formatBytes, useResourceUsage } from '../../api/system';
import { formatTokens, formatUsd } from '../../api/usage';
import { timeAgo } from '../../lib/time';
import { AgentList } from '../agents/AgentList';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ViewToggle, usePersistedView } from '../ViewToggle';
import { type AgentState, type AgentSummary, summarizeAgents } from './agentSummary';

type Tone = Parameters<typeof Badge>[0]['tone'];

const stateLabels: Record<AgentState, { label: string; tone: Tone }> = {
  waiting: { label: 'Aguardando você', tone: 'warning' },
  working: { label: 'Trabalhando', tone: 'info' },
  review: { label: 'Para revisar', tone: 'success' },
  failed: { label: 'Última falhou', tone: 'danger' },
  idle: { label: 'Livre', tone: 'neutral' },
};

const EXECUTIONS_SHOWN = 15;

interface AgentsOverviewProps {
  profiles: AgentProfile[];
  executions: Agent[];
  /** Remembers the card/table choice separately per screen. */
  viewKey: string;
  showWorkspace?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  /** Opens the launch form for a workspace agent (workspace dashboard). */
  onRun?: (profile: AgentProfile) => void;
}

/** One card per workspace agent with what it is doing now; its executions are listed below on demand. */
export function AgentsOverview({ profiles, executions, viewKey, showWorkspace = false, title, actions, onRun }: AgentsOverviewProps) {
  const [view, setView] = usePersistedView(viewKey);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const resources = useResourceUsage();
  const live = useMemo(
    () => new Map((resources.data?.containers ?? []).flatMap((container) => (container.agentId ? [[container.agentId, container]] : []))),
    [resources.data],
  );
  const summaries = useMemo(() => summarizeAgents(profiles, executions, live), [profiles, executions, live]);
  const waiting = summaries.filter((summary) => summary.state === 'waiting').length;

  const selectedSummary = summaries.find((summary) => summary.key === selected);
  const listed = selectedSummary ? selectedSummary.executions : executions;
  const select = (key: string) => {
    setSelected((current) => (current === key ? null : key));
    setShowAll(false);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {title}
            {waiting > 0 && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300">{waiting} aguardando você</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <ViewToggle view={view} onChange={setView} />
          </div>
        </div>

        {summaries.length === 0 ? (
          <p className="text-sm text-muted">Nenhum agente ainda. Crie agentes fixos na aba Agentes de um workspace.</p>
        ) : view === 'cards' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {summaries.map((summary) => (
              <AgentCard
                key={summary.key}
                summary={summary}
                showWorkspace={showWorkspace}
                selected={summary.key === selected}
                onSelect={() => select(summary.key)}
                onRun={onRun && summary.profile ? () => onRun(summary.profile!) : undefined}
              />
            ))}
          </div>
        ) : (
          <AgentTable summaries={summaries} showWorkspace={showWorkspace} selected={selected} onSelect={select} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Execuções</h2>
          {selectedSummary && (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-full border border-accent/60 bg-accent/10 px-2 py-0.5 text-xs text-accent hover:bg-accent/20"
              title="Mostrar as execuções de todos os agentes"
            >
              de {selectedSummary.name} ✕
            </button>
          )}
          <span className="text-xs text-muted">{listed.length}</span>
        </div>
        <AgentList agents={showAll ? listed : listed.slice(0, EXECUTIONS_SHOWN)} showWorkspace={showWorkspace} live={live} />
        {!showAll && listed.length > EXECUTIONS_SHOWN && (
          <Button size="sm" onClick={() => setShowAll(true)}>
            Mostrar todas ({listed.length})
          </Button>
        )}
      </section>
    </div>
  );
}

function UsageLine({ summary }: { summary: AgentSummary }) {
  if (summary.tokens === 0 && summary.liveMemory === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted tabular-nums" title="Soma de todas as execuções deste agente (custo estimado a preço de API)">
      {summary.liveMemory > 0 && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Rodando agora" />}
      ≈ {formatUsd(summary.costUsd)} · {formatTokens(summary.tokens)} tok
      {summary.liveMemory > 0 && ` · ${formatBytes(summary.liveMemory)}`}
    </span>
  );
}

function AgentCard({
  summary,
  showWorkspace,
  selected,
  onSelect,
  onRun,
}: {
  summary: AgentSummary;
  showWorkspace: boolean;
  selected: boolean;
  onSelect: () => void;
  onRun?: () => void;
}) {
  const state = stateLabels[summary.state];
  const glow = summary.state === 'waiting' ? 'glow-question border-amber-400/70' : selected ? 'border-accent' : 'border-border';
  const subtitle = [showWorkspace ? summary.workspaceName : null, summary.profile?.description || null].filter(Boolean).join(' · ');

  return (
    <article className={`flex flex-col rounded-lg border bg-panel p-4 ${glow}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{summary.name}</h3>
          {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
        </div>
        <Badge tone={state.tone}>
          {state.label}
          {summary.state === 'working' && summary.working > 1 ? ` (${summary.working})` : ''}
        </Badge>
      </div>

      {summary.waiting?.pendingQuestion?.[0] && (
        <Link
          to={`/agents/${summary.waiting.id}`}
          className="mt-3 line-clamp-2 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-400/20"
        >
          {summary.waiting.pendingQuestion[0].question}
        </Link>
      )}

      {summary.latest ? (
        <Link to={`/agents/${summary.latest.id}`} className="mt-3 flex items-center justify-between gap-2 text-xs hover:text-accent">
          <span className="truncate">
            <span className="text-muted">Última: </span>
            {summary.latest.title}
          </span>
          <AgentStatusBadge status={summary.latest.status} />
        </Link>
      ) : (
        <p className="mt-3 text-xs text-muted">Ainda não executou.</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <UsageLine summary={summary} />
        <span className="shrink-0 text-[11px] text-muted">{summary.lastActivityAt ? timeAgo(summary.lastActivityAt) : ''}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {onRun && (
          <Button size="sm" variant="primary" onClick={onRun}>
            Executar
          </Button>
        )}
        <Button size="sm" onClick={onSelect} disabled={summary.executions.length === 0}>
          {selected ? 'Mostrar todas as execuções' : `Execuções (${summary.executions.length})`}
        </Button>
      </div>
    </article>
  );
}

function AgentTable({
  summaries,
  showWorkspace,
  selected,
  onSelect,
}: {
  summaries: AgentSummary[];
  showWorkspace: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-panel text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Agente</th>
            {showWorkspace && <th className="px-4 py-2 font-medium">Workspace</th>}
            <th className="px-4 py-2 font-medium">Situação</th>
            <th className="px-4 py-2 font-medium">Última execução</th>
            <th className="px-4 py-2 font-medium">Consumo</th>
            <th className="px-4 py-2 font-medium">Execuções</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((summary) => {
            const state = stateLabels[summary.state];
            return (
              <tr
                key={summary.key}
                className={`border-t border-border ${summary.state === 'waiting' ? 'bg-amber-400/5' : ''} ${selected === summary.key ? 'bg-accent/5' : ''}`}
              >
                <td className="px-4 py-2 font-medium">{summary.name}</td>
                {showWorkspace && <td className="px-4 py-2">{summary.workspaceName ?? '—'}</td>}
                <td className="px-4 py-2">
                  <Badge tone={state.tone}>{state.label}</Badge>
                </td>
                <td className="max-w-72 px-4 py-2">
                  {summary.latest ? (
                    <Link to={`/agents/${summary.latest.id}`} className="block truncate hover:text-accent">
                      {summary.latest.title}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <UsageLine summary={summary} />
                </td>
                <td className="px-4 py-2">
                  <Button size="sm" onClick={() => onSelect(summary.key)} disabled={summary.executions.length === 0}>
                    {summary.executions.length}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
