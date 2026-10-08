import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  type PlanWindow,
  type UsageSummary,
  type UsageTotals,
  formatTokens,
  formatUsd,
  totalTokens,
  useRefreshPlanUsage,
  useUsageSummary,
} from '../../api/usage';
import { timeAgo } from '../../lib/time';
import { ErrorText } from '../form';

/** "reinicia em 2 h 10 min" / "reinicia sex., 10:00". */
function resetLabel(iso: string | null) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'reiniciada';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `reinicia em ${minutes} min`;
  if (minutes < 24 * 60) return `reinicia em ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  const date = new Date(iso);
  return `reinicia ${date.toLocaleDateString('pt-BR', { weekday: 'short' })} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function PlanBar({ window }: { window: PlanWindow }) {
  const tone = window.percent >= 90 ? 'bg-red-400' : window.percent >= 70 ? 'bg-amber-400' : 'bg-accent';
  return (
    <div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted">{window.label}</span>
        <span>
          {Math.round(window.percent)}% <span className="text-muted">· {resetLabel(window.resetsAt)}</span>
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-border">
        <div className={`h-2 rounded-full ${tone} transition-all`} style={{ width: `${Math.min(100, window.percent)}%` }} />
      </div>
    </div>
  );
}

function PlanSection({ account }: { account: UsageSummary['accounts'][number] }) {
  const refresh = useRefreshPlanUsage();
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{account.label}</span>
        <button
          type="button"
          onClick={() => refresh.mutate(account.id)}
          disabled={refresh.isPending}
          className="text-accent hover:underline disabled:opacity-50"
          title="Faz uma chamada mínima ao Claude (Haiku) para ler os limites atuais"
        >
          {refresh.isPending ? 'Atualizando...' : 'Atualizar'}
        </button>
      </div>
      {account.plan?.windows.length ? (
        account.plan.windows.map((window) => <PlanBar key={window.key} window={window} />)
      ) : (
        <p className="text-xs text-muted">Sem leitura ainda. Os limites chegam quando um agente roda ou ao clicar em Atualizar.</p>
      )}
      {account.planUpdatedAt && <p className="text-[11px] text-muted">Lido {timeAgo(account.planUpdatedAt)}.</p>}
      {account.plan?.status === 'rejected' && <p className="text-xs text-red-300">Limite atingido: os agentes ficam bloqueados até reiniciar.</p>}
      <ErrorText error={refresh.error} />
    </div>
  );
}

function Period({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="rounded-md bg-surface/60 px-2 py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{formatUsd(totals.costUsd)}</div>
      <div className="text-[11px] text-muted tabular-nums">{formatTokens(totalTokens(totals))} tokens</div>
    </div>
  );
}

/** Daily estimated cost of the last 14 days as small bars. */
function DailyBars({ daily }: { daily: UsageSummary['daily'] }) {
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - index));
    const key = date.toLocaleDateString('sv-SE');
    return { key, label: date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), entry: daily.find((row) => row.day === key) };
  });
  const max = Math.max(...days.map((day) => day.entry?.costUsd ?? 0), 0.0001);
  return (
    <div className="flex h-12 items-end gap-0.5">
      {days.map((day) => (
        <div
          key={day.key}
          className="flex-1 rounded-sm bg-accent/70"
          style={{ height: `${Math.max(4, ((day.entry?.costUsd ?? 0) / max) * 100)}%`, opacity: day.entry ? 1 : 0.25 }}
          title={`${day.label}: ${formatUsd(day.entry?.costUsd ?? 0)} · ${formatTokens(day.entry?.tokens ?? 0)} tokens`}
        />
      ))}
    </div>
  );
}

function Ranking({ title, rows }: { title: string; rows: { key: string; label: ReactNode; costUsd: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wider text-muted uppercase">{title}</h3>
      <ul className="mt-1 divide-y divide-border/60">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-2 py-1 text-xs">
            <span className="truncate">{row.label}</span>
            <span className="shrink-0 text-muted tabular-nums">{formatUsd(row.costUsd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const modelName = (model: string) => model.replace(/^claude-/, '').replace(/-/g, ' ');

/** Without a workspace: usage of all workspaces; with one, only its agents (plan limits stay the account's). */
export function ClaudeUsagePanel({ workspaceId }: { workspaceId?: string }) {
  const summary = useUsageSummary(workspaceId);
  if (summary.error) return <ErrorText error={summary.error} />;
  if (!summary.data) return <p className="text-sm text-muted">Carregando...</p>;
  const data = summary.data;

  return (
    <div className="space-y-4">
      {data.accounts.length === 0 ? (
        <p className="text-xs text-muted">
          {workspaceId ? 'Este workspace não tem conta Claude configurada.' : 'Nenhuma conta Claude cadastrada.'}
        </p>
      ) : (
        data.accounts.map((account) => <PlanSection key={account.id} account={account} />)
      )}
      {workspaceId && data.accounts.length > 0 && (
        <p className="text-[11px] text-muted">Os limites do plano são da conta inteira, compartilhados entre os workspaces que a usam.</p>
      )}

      <div>
        <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Uso dos agentes</h3>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <Period label="Hoje" totals={data.periods.today} />
          <Period label="7 dias" totals={data.periods.week} />
          <Period label="30 dias" totals={data.periods.month} />
        </div>
        <div className="mt-2">
          <DailyBars daily={data.daily} />
        </div>
      </div>

      {!workspaceId && (
        <Ranking
          title="Por workspace (30 dias)"
          rows={data.byWorkspace.map((row) => ({ key: row.workspaceId, label: row.name, costUsd: row.costUsd }))}
        />
      )}
      <Ranking
        title="Por modelo (30 dias)"
        rows={data.byModel.map((row) => ({ key: row.model, label: modelName(row.model), costUsd: row.costUsd }))}
      />
      <Ranking
        title="Agentes que mais gastaram"
        rows={data.topAgents.map((row) => ({
          key: row.agentId,
          label: (
            <Link to={`/agents/${row.agentId}`} className="hover:text-accent">
              {row.title}
            </Link>
          ),
          costUsd: row.costUsd,
        }))}
      />

      <p className="text-[11px] text-muted">
        Valores em dólar são estimativas a preço de API, para comparar tarefas; no plano Max o uso é coberto pela
        assinatura e limitado pelas janelas acima.
      </p>
    </div>
  );
}
