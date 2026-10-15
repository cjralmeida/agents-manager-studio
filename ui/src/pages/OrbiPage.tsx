import { type ReactNode, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgent } from '../api/agents';
import { type Conversation, useConversations } from '../api/assistant';
import {
  type OrbiActivity,
  type OrbiPending,
  type PilotSettings,
  useDecideSuggestion,
  useOrbiActivity,
  useOrbiPending,
  usePilot,
  useResolveFlag,
  useUpdatePilot,
} from '../api/orbi';
import { useWorkspaces } from '../api/workspaces';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ErrorText, Select } from '../components/form';
import { Logo } from '../components/Logo';
import { NewConversation, OrbiConversation } from '../components/orbi/OrbiPanel';
import { timeAgo } from '../lib/time';

const FOCUS_KEY = 'ams.orbi.workspace';

function storedFocus() {
  try {
    return localStorage.getItem(FOCUS_KEY);
  } catch {
    return null;
  }
}

/**
 * Órbi's command center: the conversation in the middle; on the left the conversations (the pilot's first); on the
 * right the pilot mode, what waits for someone and what Órbi did by itself.
 */
export function OrbiPage() {
  const [params, setParams] = useSearchParams();
  const conversations = useConversations();
  const pilot = usePilot();
  const selected = params.get('c');
  const current = selected === 'new' ? null : (selected ?? conversations.data?.[0]?.id ?? null);
  const open = (id: string | 'new') => setParams(id ? { c: id } : {}, { replace: false });
  const workspaces = useWorkspaces();
  // The pilot covers several workspaces: its conversation shows them, not the workspace it happened to start in.
  const pilotScope = !pilot.data
    ? ''
    : pilot.data.allWorkspaces
      ? 'Todos os workspaces'
      : (workspaces.data ?? []).filter((workspace) => pilot.data!.workspaceIds.includes(workspace.id)).map((workspace) => workspace.name).join(', ');

  return (
    <div className="mx-auto grid max-w-[1600px] gap-5 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_23rem]">
      <aside className="space-y-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
        <OrbiHeader pilot={pilot.data} />
        <Button variant="primary" className="w-full" onClick={() => open('new')}>
          Nova conversa
        </Button>
        <ConversationList
          conversations={conversations.data ?? []}
          pilotId={pilot.data?.conversationId ?? null}
          pilotScope={pilotScope}
          current={current}
          onOpen={open}
        />
      </aside>

      <section className="min-w-0">
        {current ? <CurrentConversation key={current} id={current} /> : <StartConversation onStarted={open} />}
      </section>

      <aside className="space-y-4 lg:col-span-2 xl:sticky xl:top-0 xl:col-span-1 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
        <PilotCard />
        <PendingCard onOpenConversation={open} />
        <ActivityCard onOpenConversation={open} />
      </aside>
    </div>
  );
}

function OrbiHeader({ pilot }: { pilot?: PilotSettings }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-gradient-to-br from-accent/15 to-transparent p-3">
      <Logo size={40} working={pilot?.enabled} />
      <div className="min-w-0">
        <h1 className="text-lg leading-tight font-semibold">Órbi</h1>
        <p className="text-xs text-muted">{pilot?.enabled ? 'Piloto ligado' : 'Opera o Studio com você'}</p>
      </div>
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

function ConversationList({
  conversations,
  pilotId,
  pilotScope,
  current,
  onOpen,
}: {
  conversations: Conversation[];
  pilotId: string | null;
  pilotScope: string;
  current: string | null;
  onOpen: (id: string) => void;
}) {
  if (conversations.length === 0) return <p className="px-1 text-xs text-muted">Nenhuma conversa ainda.</p>;
  // The pilot's conversation first: it is where Órbi tells what it handled by itself.
  const sorted = [...conversations].sort((a, b) => Number(b.id === pilotId) - Number(a.id === pilotId));
  return (
    <ul className="space-y-1">
      {sorted.map((conversation) => {
        const busy = conversation.status === 'RUNNING' || conversation.status === 'PREPARING';
        const isPilot = conversation.id === pilotId;
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onOpen(conversation.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                conversation.id === current ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:bg-border/50'
              } ${busy ? 'glow-working-row' : ''}`}
            >
              <div className="flex items-center gap-1.5">
                {isPilot && <Badge tone="info">Piloto</Badge>}
                {conversation.status === 'WAITING_INPUT' && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Esperando você" />}
                <span className="truncate text-sm">{conversation.title}</span>
              </div>
              <div className="mt-0.5 flex justify-between gap-2 text-[11px] text-muted">
                <span className="truncate">{isPilot ? pilotScope : conversation.workspaceName}</span>
                <span className="shrink-0">{timeAgo(conversation.lastActivityAt)}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CurrentConversation({ id }: { id: string }) {
  const agent = useAgent(id);
  const [, setAnswering] = useState(false);
  if (!agent.data) return <ErrorText error={agent.error} />;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
        <h2 className="truncate text-base font-semibold">{agent.data.title.replace(/^Órbi: /, '')}</h2>
        <span className="shrink-0 text-xs text-muted">Foco: {agent.data.workspaceName}</span>
      </div>
      <OrbiConversation agentId={id} workspaceId={agent.data.workspaceId} onAnswering={setAnswering} />
    </div>
  );
}

function StartConversation({ onStarted }: { onStarted: (id: string) => void }) {
  const workspaces = useWorkspaces();
  const available = workspaces.data?.filter((workspace) => !workspace.isMissing && !workspace.isIgnored) ?? [];
  const [focus, setFocus] = useState<string | null>(storedFocus());
  const workspaceId = available.find((workspace) => workspace.id === focus)?.id ?? available[0]?.id ?? null;
  useEffect(() => {
    try {
      if (workspaceId) localStorage.setItem(FOCUS_KEY, workspaceId);
    } catch {
      // Preference only.
    }
  }, [workspaceId]);
  if (!workspaceId) return <p className="text-sm text-muted">Nenhum workspace disponível.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <h2 className="text-base font-semibold">Nova conversa</h2>
        <span className="ml-auto text-xs text-muted">Começa em</span>
        <Select className="w-auto py-1 text-xs" value={workspaceId} onChange={(event) => setFocus(event.target.value)} aria-label="Workspace em foco">
          {available.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-h-[60vh]">
        <NewConversation workspaceId={workspaceId} onStarted={onStarted} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pilot

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-border'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}

function PilotCard() {
  const pilot = usePilot();
  const update = useUpdatePilot();
  const workspaces = useWorkspaces();
  const available = workspaces.data?.filter((workspace) => !workspace.isMissing && !workspace.isIgnored) ?? [];
  const [instructions, setInstructions] = useState<string | null>(null);
  const settings = pilot.data;
  if (!settings) return <Card title="Modo piloto">{pilot.error ? <ErrorText error={pilot.error} /> : <p className="text-xs text-muted">Carregando...</p>}</Card>;
  const draft = instructions ?? settings.instructions;

  return (
    <Card title="Modo piloto" aside={<Switch checked={settings.enabled} onChange={(enabled) => update.mutate({ enabled })} label="Ligar o modo piloto" />}>
      <p className="text-xs text-muted">
        {settings.enabled
          ? 'Ligado: quando um agente pergunta, uma execução falha ou o Gestor de Capacidade sugere algo, eu resolvo e registro abaixo. O que precisar de você vira aviso.'
          : 'Desligado: eu só ajo quando você me chama. Ligue para eu responder os agentes e cuidar das falhas enquanto você está fora.'}
      </p>
      {settings.lastEventAt && <p className="mt-1 text-[11px] text-muted">Último evento tratado {timeAgo(settings.lastEventAt)}.</p>}

      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium">Onde</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={settings.allWorkspaces} onClick={() => update.mutate({ allWorkspaces: true })}>
              Todos os workspaces
            </Chip>
            {available.map((workspace) => {
              const active = !settings.allWorkspaces && settings.workspaceIds.includes(workspace.id);
              return (
                <Chip
                  key={workspace.id}
                  active={active}
                  onClick={() => {
                    const base = settings.allWorkspaces ? [] : settings.workspaceIds;
                    const workspaceIds = active ? base.filter((id) => id !== workspace.id) : [...base, workspace.id];
                    update.mutate(workspaceIds.length === 0 ? { allWorkspaces: true, workspaceIds } : { allWorkspaces: false, workspaceIds });
                  }}
                >
                  {workspace.name}
                </Chip>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">Modelo</span>
          <Select className="w-auto py-1 text-xs" value={settings.model} onChange={(event) => update.mutate({ model: event.target.value as PilotSettings['model'] })}>
            <option value="sonnet">Sonnet (econômico)</option>
            <option value="opus">Opus (julga melhor arte e escopo)</option>
          </Select>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">Suas regras para o piloto</p>
          <textarea
            value={draft}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            placeholder='Ex.: "mudança grande de escopo espera por mim"; "no Celcode aprove arte só depois de ver as imagens".'
            className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
          />
          {instructions !== null && instructions !== settings.instructions && (
            <div className="mt-1 flex justify-end gap-2">
              <Button size="sm" onClick={() => setInstructions(null)}>
                Desfazer
              </Button>
              <Button size="sm" variant="primary" disabled={update.isPending} onClick={() => update.mutate({ instructions: draft }, { onSuccess: () => setInstructions(null) })}>
                Salvar
              </Button>
            </div>
          )}
        </div>
        <ErrorText error={update.error} />
      </div>
    </Card>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:border-accent/50'}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- pending

function PendingCard({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const pending = useOrbiPending();
  const decide = useDecideSuggestion();
  const resolve = useResolveFlag();
  const data = pending.data;
  const name = (id: string | null) => data?.workspaces.find((workspace) => workspace.id === id)?.name ?? '';
  const total = data ? data.questions.length + data.failedRuns.length + data.capacitySuggestions.length + data.proposals.length + data.flags.length : 0;

  return (
    <Card title="Pendências" aside={total > 0 ? <Badge tone="warning">{total}</Badge> : undefined}>
      {!data ? (
        pending.error ? <ErrorText error={pending.error} /> : <p className="text-xs text-muted">Carregando...</p>
      ) : total === 0 ? (
        <p className="text-xs text-muted">Nada esperando. Tudo andando.</p>
      ) : (
        <div className="space-y-3">
          <PendingGroup title="Avisos para você" items={data.flags}>
            {(flag: OrbiActivity) => (
              <Row key={flag.id} tone="warning" title={flag.summary} meta={`${flag.workspaceName ?? ''} · ${timeAgo(flag.createdAt)}`}>
                {flag.link && <RowLink to={flag.link}>Abrir</RowLink>}
                <Button size="sm" onClick={() => resolve.mutate(flag.id)}>
                  Resolvido
                </Button>
              </Row>
            )}
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
              <Row key={entry.proposalId} title={entry.summary} meta={name(entry.workspaceId)}>
                <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: entry.proposalId, decision: 'apply' })}>
                  Aplicar
                </Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: entry.proposalId, decision: 'discard' })}>
                  Descartar
                </Button>
              </Row>
            )}
          </PendingGroup>
          <PendingGroup title="Propostas do Órbi" items={data.proposals}>
            {(entry: OrbiPending['proposals'][number]) => (
              <Row key={entry.id} title={entry.summary} meta={name(entry.workspaceId)}>
                <Button size="sm" onClick={() => onOpenConversation(entry.agentId)}>
                  Ver
                </Button>
              </Row>
            )}
          </PendingGroup>
          <PendingGroup title="Falhas nas últimas 24 h" items={data.failedRuns}>
            {(entry: OrbiPending['failedRuns'][number]) => (
              <Row key={entry.runId} tone="danger" title={entry.title} meta={`${entry.workflow} · ${name(entry.workspaceId)}`} detail={entry.error}>
                {entry.executionId && <RowLink to={`/agents/${entry.executionId}`}>Abrir</RowLink>}
              </Row>
            )}
          </PendingGroup>
          <ErrorText error={decide.error ?? resolve.error} />
        </div>
      )}
    </Card>
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
  flag: { label: 'Aviso', tone: 'warning' },
};

function ActivityCard({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const activity = useOrbiActivity();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Card title="O que o Órbi fez">
      {!activity.data ? (
        activity.error ? <ErrorText error={activity.error} /> : <p className="text-xs text-muted">Carregando...</p>
      ) : activity.data.length === 0 ? (
        <p className="text-xs text-muted">Ainda nada. As ações que eu fizer aparecem aqui, com o motivo.</p>
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
                  <span>· {timeAgo(entry.createdAt)}</span>
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
                      {entry.conversationId && (
                        <Button size="sm" onClick={() => onOpenConversation(entry.conversationId!)}>
                          Conversa
                        </Button>
                      )}
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
