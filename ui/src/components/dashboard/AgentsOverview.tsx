import { type MouseEvent, type ReactNode, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Agent } from '../../api/agents';
import { formatBytes, useResourceUsage } from '../../api/system';
import { formatTokens, formatUsd } from '../../api/usage';
import { plural, timeAgo } from '../../lib/time';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ViewToggle, usePersistedView } from '../ViewToggle';
import { type AgentState, type AgentSummary, agentPagePath, summarizeAgents } from './agentSummary';

type Tone = Parameters<typeof Badge>[0]['tone'];

export const agentStateLabels: Record<AgentState, { label: string; tone: Tone }> = {
  waiting: { label: 'Aguardando você', tone: 'warning' },
  working: { label: 'Trabalhando', tone: 'info' },
  review: { label: 'Para revisar', tone: 'success' },
  failed: { label: 'Última falhou', tone: 'danger' },
  idle: { label: 'Livre', tone: 'neutral' },
};

const ACTIVE_STATUSES = ['PREPARING', 'RUNNING', 'FINALIZING'];

/** Whether the latest execution's status says the same as the card state. */
function repeatsCardState(state: string, status: string) {
  return (state === 'working' && ACTIVE_STATUSES.includes(status)) || (state === 'waiting' && status === 'WAITING_INPUT');
}

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

/** One card per workspace agent with what it is doing now; its executions live on the agent page. */
export function AgentsOverview({ profiles, executions, viewKey, showWorkspace = false, title, actions, onRun }: AgentsOverviewProps) {
  const [view, setView] = usePersistedView(viewKey);
  const resources = useResourceUsage();
  const live = useMemo(
    () => new Map((resources.data?.containers ?? []).flatMap((container) => (container.agentId ? [[container.agentId, container]] : []))),
    [resources.data],
  );
  const summaries = useMemo(() => summarizeAgents(profiles, executions, live), [profiles, executions, live]);
  const waiting = summaries.filter((summary) => summary.state === 'waiting').length;

  return (
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
              onRun={onRun && summary.profile ? () => onRun(summary.profile!) : undefined}
            />
          ))}
        </div>
      ) : (
        <AgentTable summaries={summaries} showWorkspace={showWorkspace} />
      )}
    </section>
  );
}

export function AgentUsageSummary({ summary }: { summary: Pick<AgentSummary, 'costUsd' | 'tokens' | 'liveMemory'> }) {
  if (summary.tokens === 0 && summary.liveMemory === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted tabular-nums" title="Soma de todas as execuções deste agente (custo estimado a preço de API)">
      {summary.liveMemory > 0 && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Rodando agora" />}
      ≈ {formatUsd(summary.costUsd)} · {formatTokens(summary.tokens)} tok
      {summary.liveMemory > 0 && ` · ${formatBytes(summary.liveMemory)}`}
    </span>
  );
}

/** The whole card opens the agent page; the question and the latest execution link straight to that execution. */
function AgentCard({ summary, showWorkspace, onRun }: { summary: AgentSummary; showWorkspace: boolean; onRun?: () => void }) {
  const navigate = useNavigate();
  const state = agentStateLabels[summary.state];
  const subtitle = [showWorkspace ? summary.workspaceName : null, summary.profile?.description || null].filter(Boolean).join(' · ');
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <article
      onClick={() => navigate(agentPagePath(summary))}
      className={`flex cursor-pointer flex-col rounded-lg border bg-panel p-4 transition-colors hover:border-accent/60 ${
        summary.state === 'waiting' ? 'glow-question border-amber-400/70' : summary.state === 'working' ? 'glow-working' : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={agentPagePath(summary)} onClick={stop} className="block truncate text-sm font-semibold hover:text-accent">
            {summary.name}
          </Link>
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
          onClick={stop}
          className="mt-3 line-clamp-2 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-400/20"
        >
          {summary.waiting.pendingQuestion[0].question}
        </Link>
      )}

      {summary.latest ? (
        <Link to={`/agents/${summary.latest.id}`} onClick={stop} className="mt-3 flex items-center justify-between gap-2 text-xs hover:text-accent">
          <span className="truncate">
            <span className="text-muted">Última: </span>
            {summary.latest.title}
          </span>
          {/* The card badge already says "Trabalhando"/"Aguardando"; the latest execution's badge only adds something new. */}
          {!repeatsCardState(summary.state, summary.latest.status) && <AgentStatusBadge status={summary.latest.status} />}
        </Link>
      ) : (
        <p className="mt-3 text-xs text-muted">Ainda não executou.</p>
      )}

      {/* Wraps to two lines on narrow cards instead of overflowing. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3">
        <AgentUsageSummary summary={summary} />
        <span className="text-[11px] whitespace-nowrap text-muted">
          {plural(summary.executions.length, 'execução', 'execuções')}
          {summary.lastActivityAt ? ` · ${timeAgo(summary.lastActivityAt)}` : ''}
        </span>
      </div>
      {onRun && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="primary"
            onClick={(event) => {
              stop(event);
              onRun();
            }}
          >
            Executar
          </Button>
        </div>
      )}
    </article>
  );
}

function AgentTable({ summaries, showWorkspace }: { summaries: AgentSummary[]; showWorkspace: boolean }) {
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
            const state = agentStateLabels[summary.state];
            return (
              <tr key={summary.key} className={`border-t border-border hover:bg-border/30 ${summary.state === 'waiting' ? 'bg-amber-400/5' : ''}`}>
                <td className="px-4 py-2">
                  <Link to={agentPagePath(summary)} className="font-medium hover:text-accent">
                    {summary.name}
                  </Link>
                </td>
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
                  <AgentUsageSummary summary={summary} />
                </td>
                <td className="px-4 py-2 tabular-nums">{summary.executions.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
