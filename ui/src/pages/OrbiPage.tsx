import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useAgent } from '../api/agents';
import { useConversations } from '../api/assistant';
import {
  type OrbiActivity,
  type OrbiPending,
  useDecideFlag,
  useDecideSuggestion,
  useMarkSeen,
  useOrbiActivity,
  useOrbiConversation,
  useOrbiPending,
  useResolveFlag,
  useRestartOrbi,
  useSetOrbiModel,
} from '../api/orbi';
import { useDecideCapacity } from '../api/capacity';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ErrorText, Select } from '../components/form';
import { Logo } from '../components/Logo';
import { OrbiConversation, OrbiStart } from '../components/orbi/OrbiPanel';
import { RoutinesCard } from '../components/orbi/Routines';
import { timeAgo } from '../lib/time';

/**
 * Órbi's page: the user's one conversation in the middle; on the side the routines (what Órbi does by itself), the
 * decisions waiting for the user and what Órbi did.
 */
export function OrbiPage() {
  const info = useOrbiConversation();
  const current = info.data?.conversationId ?? null;
  const [answering, setAnswering] = useState(false);

  return (
    <div className="mx-auto grid max-w-[1500px] gap-5 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <section className="min-w-0 space-y-3">
        <ConversationHeader conversationId={current} working={answering} />
        {info.error ? (
          <ErrorText error={info.error} />
        ) : !info.data ? (
          <p className="text-sm text-muted">Carregando...</p>
        ) : current ? (
          <OrbiConversation key={current} agentId={current} onAnswering={setAnswering} />
        ) : (
          <div className="min-h-[60vh]">
            <OrbiStart />
          </div>
        )}
      </section>

      <aside className="space-y-4 xl:sticky xl:top-0 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
        <RoutinesCard card={(title, aside, children) => <Card title={title} aside={aside}>{children}</Card>} />
        <DecisionsCard />
        <ActivityCard />
      </aside>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Órbi, the workspace it is focused on, its model, a fresh start and the older conversations. */
function ConversationHeader({ conversationId, working }: { conversationId: string | null; working: boolean }) {
  const info = useOrbiConversation();
  const agent = useAgent(conversationId ?? '');
  const setModel = useSetOrbiModel();
  const restart = useRestartOrbi();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-gradient-to-br from-accent/15 to-transparent p-3">
      <Logo size={40} working={working} />
      <div className="min-w-0 flex-1">
        <h1 className="text-lg leading-tight font-semibold">Órbi</h1>
        <p className="text-xs text-muted">{conversationId && agent.data ? `Foco: ${agent.data.workspaceName}` : 'Opera o Studio com você'}</p>
      </div>
      <Select
        className="w-auto py-1 text-xs"
        value={info.data?.model ?? 'sonnet'}
        onChange={(event) => setModel.mutate(event.target.value as 'sonnet' | 'opus')}
        aria-label="Modelo do Órbi"
        title="Vale a partir da próxima vez que a conversa iniciar"
      >
        <option value="sonnet">Sonnet (econômico)</option>
        <option value="opus">Opus (julga melhor)</option>
      </Select>
      <OldConversations current={conversationId} />
      {conversationId &&
        (confirming ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span>Começar do zero? A conversa atual fica no histórico.</span>
            <Button size="sm" variant="primary" disabled={restart.isPending} onClick={() => restart.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
              Recomeçar
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Não
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setConfirming(true)} title="Começa uma conversa nova, com o contexto limpo">
            Recomeçar
          </Button>
        ))}
      <ErrorText error={setModel.error ?? restart.error} />
    </div>
  );
}

/** The conversations from before (old pilots, restarts): read on the agent page. */
function OldConversations({ current }: { current: string | null }) {
  const conversations = useConversations();
  const [open, setOpen] = useState(false);
  const old = (conversations.data ?? []).filter((conversation) => conversation.id !== current);
  if (old.length === 0) return null;
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen(!open)}>
        Histórico ({old.length})
      </Button>
      {open && (
        <ul className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-panel p-1 shadow-xl">
          {old.map((conversation) => (
            <li key={conversation.id}>
              <Link to={`/agents/${conversation.id}`} className="block rounded-md px-2 py-1.5 text-xs hover:bg-border/50">
                <span className="block truncate">{conversation.title}</span>
                <span className="text-[11px] text-muted">
                  {conversation.workspaceName} · {timeAgo(conversation.lastActivityAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- decisions

/** What waits for the user: Órbi's decisions (with their options), agent questions, suggestions, proposals, failures. */
function DecisionsCard() {
  const pending = useOrbiPending();
  const decideProposal = useDecideSuggestion();
  const capacity = useDecideCapacity();
  const seen = useMarkSeen();
  const data = pending.data;
  const name = (id: string | null) => data?.workspaces.find((workspace) => workspace.id === id)?.name ?? '';
  const total = data ? data.questions.length + data.failedRuns.length + data.capacitySuggestions.length + data.proposals.length + data.flags.length : 0;

  return (
    <Card title="Decisões" aside={total > 0 ? <Badge tone="warning">{total}</Badge> : undefined}>
      {!data ? (
        pending.error ? <ErrorText error={pending.error} /> : <p className="text-xs text-muted">Carregando...</p>
      ) : total === 0 ? (
        <p className="text-xs text-muted">Nada esperando você. Tudo andando.</p>
      ) : (
        <div className="space-y-3">
          <PendingGroup title="O Órbi precisa de você" items={data.flags}>
            {(flag: OrbiActivity) => <FlagRow key={flag.id} flag={flag} />}
          </PendingGroup>
          <PendingGroup title="Agentes esperando resposta" items={data.questions}>
            {(entry: OrbiPending['questions'][number]) => (
              <Row key={entry.agentId} tone="question" title={entry.title} meta={`${name(entry.workspaceId)} · há ${timeAgo(entry.waitingSince).replace(/^há /, '')}`}>
                <RowLink to={`/agents/${entry.agentId}#pergunta`}>Responder</RowLink>
              </Row>
            )}
          </PendingGroup>
          <PendingGroup title="Sugestões de capacidade" items={data.capacitySuggestions}>
            {(entry: OrbiPending['capacitySuggestions'][number]) => (
              <Row key={entry.proposalId} title={entry.summary.split('\n').join(' · ')} meta={name(entry.workspaceId)}>
                <Button size="sm" variant="primary" disabled={capacity.isPending} onClick={() => capacity.mutate({ id: entry.proposalId, decision: 'apply' })}>
                  Aplicar
                </Button>
                <Button size="sm" disabled={capacity.isPending} onClick={() => capacity.mutate({ id: entry.proposalId, decision: 'discard' })}>
                  Descartar
                </Button>
              </Row>
            )}
          </PendingGroup>
          <PendingGroup title="Propostas do Órbi" items={data.proposals}>
            {(entry: OrbiPending['proposals'][number]) => (
              <Row key={entry.id} title={entry.summary} meta={name(entry.workspaceId)}>
                <RowLink to={`/agents/${entry.agentId}`}>Ver</RowLink>
                <Button size="sm" disabled={decideProposal.isPending} onClick={() => decideProposal.mutate({ id: entry.id, decision: 'discard' })}>
                  Descartar
                </Button>
              </Row>
            )}
          </PendingGroup>
          <PendingGroup title="Falhas nas últimas 24 h" items={data.failedRuns}>
            {(entry: OrbiPending['failedRuns'][number]) => (
              <Row key={entry.runId} tone="danger" title={entry.title} meta={`${entry.workflow} · ${name(entry.workspaceId)}`} detail={entry.error}>
                {entry.executionId && <RowLink to={`/agents/${entry.executionId}`}>Abrir</RowLink>}
                <Button size="sm" disabled={seen.isPending} onClick={() => seen.mutate([entry.runId])}>
                  Visto
                </Button>
              </Row>
            )}
          </PendingGroup>
          {data.failedRuns.length > 1 && (
            <button type="button" disabled={seen.isPending} onClick={() => seen.mutate(undefined)} className="text-[11px] text-muted hover:text-accent disabled:opacity-50">
              Marcar todas as falhas como vistas
            </button>
          )}
          <ErrorText error={decideProposal.error ?? capacity.error ?? seen.error} />
        </div>
      )}
    </Card>
  );
}

/** A decision Órbi left: pick an option (it goes to the conversation and Órbi does it), talk it over, or drop it. */
function FlagRow({ flag }: { flag: OrbiActivity }) {
  const decide = useDecideFlag();
  const resolve = useResolveFlag();
  const details = (flag.details ?? {}) as { details?: string | null; options?: string[]; decidedOption?: string | null };
  const options = details.options ?? [];
  const decided = details.decidedOption ?? null;
  return (
    <li className="rounded-lg border border-amber-500/40 bg-surface/60 px-3 py-2">
      <p className="text-xs leading-snug">{flag.summary}</p>
      {details.details && <p className="mt-1 text-[11px] whitespace-pre-wrap text-muted">{details.details}</p>}
      {decided ? (
        <p className="mt-1.5 text-[11px] text-accent">Você escolheu "{decided}". O Órbi está cuidando.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option, index) => (
            <Button key={option} size="sm" variant={index === 0 ? 'primary' : 'secondary'} disabled={decide.isPending} onClick={() => decide.mutate({ id: flag.id, option })}>
              {option}
            </Button>
          ))}
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: flag.id })} title="Leva a decisão para a conversa, para resolverem juntos">
            Conversar
          </Button>
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted">
          {flag.workspaceName ?? ''} · {timeAgo(flag.createdAt)}
        </span>
        <div className="flex shrink-0 gap-1.5">
          {flag.link && <RowLink to={flag.link}>Abrir</RowLink>}
          <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate(flag.id)} title="Tira da lista sem pedir nada ao Órbi">
            Dispensar
          </Button>
        </div>
      </div>
      <ErrorText error={decide.error ?? resolve.error} />
    </li>
  );
}

function PendingGroup<T>({ title, items, children }: { title: string; items: T[]; children: (item: T) => ReactNode }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">
        {title} <span className="text-muted/70">({items.length})</span>
      </h3>
      <ul className="space-y-1.5">{items.map(children)}</ul>
    </div>
  );
}

const ROW_TONES = {
  neutral: 'border-border',
  warning: 'border-amber-500/40',
  question: 'border-amber-400/50 glow-question',
  danger: 'border-red-500/40',
};

function Row({ title, meta, detail, tone = 'neutral', children }: { title: string; meta: string; detail?: string | null; tone?: keyof typeof ROW_TONES; children?: ReactNode }) {
  return (
    <li className={`rounded-lg border bg-surface/60 px-3 py-2 ${ROW_TONES[tone]}`}>
      <p className="text-xs leading-snug">{title}</p>
      {detail && <p className="mt-0.5 line-clamp-2 text-[11px] text-red-300/90">{detail}</p>}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted">{meta}</span>
        <div className="flex shrink-0 gap-1.5">{children}</div>
      </div>
    </li>
  );
}

function RowLink({ to, children }: { to: string; children: ReactNode }) {
  const external = /^https?:/.test(to);
  const className = 'rounded-md border border-border px-2 py-1 text-xs font-medium hover:border-accent/60';
  return external ? (
    <a href={to} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- activity

const KIND_LABELS: Record<OrbiActivity['kind'], { label: string; tone: 'neutral' | 'warning' | 'info' | 'success' | 'danger' }> = {
  answer: { label: 'Respondeu', tone: 'info' },
  message: { label: 'Mensagem', tone: 'neutral' },
  task: { label: 'Tarefa', tone: 'neutral' },
  workflow: { label: 'Workflow', tone: 'neutral' },
  pause: { label: 'Pausa', tone: 'warning' },
  resume: { label: 'Retomada', tone: 'success' },
  capacity: { label: 'Capacidade', tone: 'info' },
  conflict: { label: 'Conflito', tone: 'danger' },
  flag: { label: 'DecisÃ£o', tone: 'warning' },
};

function ActivityCard() {
  const activity = useOrbiActivity();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Card title="O que o Ã“rbi fez">
      {!activity.data ? (
        activity.error ? <ErrorText error={activity.error} /> : <p className="text-xs text-muted">Carregando...</p>
      ) : activity.data.length === 0 ? (
        <p className="text-xs text-muted">Ainda nada. As aÃ§Ãµes que eu fizer aparecem aqui, com o motivo.</p>
      ) : (
        <ol className="relative space-y-3 border-l border-border pl-4">
          {activity.data.map((entry) => {
            const kind = KIND_LABELS[entry.kind] ?? KIND_LABELS.message;
            const reason = typeof entry.details?.reason === 'string' ? entry.details.reason : null;
            return (
              <li key={entry.id} className="relative">
                <span className="absolute top-1.5 -left-[1.3rem] h-2 w-2 rounded-full bg-accent/70 ring-2 ring-panel" />
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <Badge tone={kind.tone}>{kind.label}</Badge>
                  {entry.workspaceName && <span>{entry.workspaceName}</span>}
                  <span>Â· {timeAgo(entry.createdAt)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  className="mt-0.5 text-left text-xs leading-snug hover:text-white"
                >
                  {entry.summary}
                </button>
                {expanded === entry.id && (
                  <div className="mt-1 space-y-1 text-[11px] text-muted">
                    {reason && <p className="whitespace-pre-wrap">Motivo: {reason}</p>}
                    <div className="flex gap-2">
                      {entry.link && <RowLink to={entry.link}>Abrir</RowLink>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
