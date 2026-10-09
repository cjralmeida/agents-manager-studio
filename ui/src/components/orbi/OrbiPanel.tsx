import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react';
import { useLocation, useMatch } from 'react-router';
import { type AgentEvent, useAgent } from '../../api/agents';
import { useConversations, useProposals, useSendToConversation, useStartConversation } from '../../api/assistant';
import { useWorkspaces } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Conversation } from '../agents/Conversation';
import { Button } from '../Button';
import { ErrorText, Select } from '../form';
import { Logo } from '../Logo';
import { ProposalCard } from './ProposalCard';

const WORKSPACE_KEY = 'ams.orbi.workspace';

const SUGGESTIONS = [
  'Monte um workflow que documenta, planeja, implementa, testa e publica em homologação.',
  'Por que a última execução falhou?',
  'Quanto os agentes gastaram nesta semana?',
  'Crie um agente que corrige bugs do app.',
];

function storedWorkspace() {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/** Where the user is, sent with each message so Órbi understands "este workflow", "aqui". */
function usePageContext() {
  const location = useLocation();
  return `página ${location.pathname}${location.search}`;
}

/** Órbi: the assistant panel, available from any screen. */
export function OrbiPanel({ onClose }: { onClose: () => void }) {
  const workspaces = useWorkspaces();
  const routeWorkspace = useMatch('/workspaces/:workspaceId/*')?.params.workspaceId ?? null;
  const available = workspaces.data?.filter((workspace) => !workspace.isMissing && !workspace.isIgnored) ?? [];
  const [workspaceId, setWorkspaceId] = useState<string | null>(routeWorkspace ?? storedWorkspace());
  const effectiveWorkspace = available.find((workspace) => workspace.id === workspaceId)?.id ?? available[0]?.id ?? null;
  const conversations = useConversations(effectiveWorkspace);
  /** null = most recent conversation; "new" = a fresh one. */
  const [conversationId, setConversationId] = useState<string | 'new' | null>(null);
  const current = conversationId === 'new' ? null : (conversationId ?? conversations.data?.[0]?.id ?? null);
  /** Órbi is answering: the panel gets the purple light, like working agents. */
  const [answering, setAnswering] = useState(false);

  // Follows the workspace the user navigates to.
  useEffect(() => {
    if (routeWorkspace) setWorkspaceId(routeWorkspace);
  }, [routeWorkspace]);
  useEffect(() => {
    try {
      if (effectiveWorkspace) localStorage.setItem(WORKSPACE_KEY, effectiveWorkspace);
    } catch {
      // Preference only.
    }
  }, [effectiveWorkspace]);

  return (
    <aside
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-surface shadow-2xl ${
        answering && current ? 'glow-working' : 'border-border'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Logo size={26} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Órbi</h2>
          <p className="text-[11px] text-muted">Assistente do Studio · propõe, você aplica</p>
        </div>
        <Button size="sm" onClick={onClose}>
          Fechar
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Select
          className="w-auto flex-1 py-1 text-xs"
          value={effectiveWorkspace ?? ''}
          onChange={(event) => {
            setWorkspaceId(event.target.value);
            setConversationId(null);
          }}
          aria-label="Workspace"
        >
          {available.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </Select>
        <Select
          className="w-auto flex-1 py-1 text-xs"
          value={current ?? 'new'}
          onChange={(event) => setConversationId(event.target.value)}
          aria-label="Conversa"
        >
          <option value="new">Nova conversa</option>
          {conversations.data?.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title} · {timeAgo(conversation.lastActivityAt)}
            </option>
          ))}
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!effectiveWorkspace ? (
          <p className="text-sm text-muted">Nenhum workspace disponível.</p>
        ) : current ? (
          <OrbiConversation key={current} agentId={current} workspaceId={effectiveWorkspace} onAnswering={setAnswering} />
        ) : (
          <NewConversation workspaceId={effectiveWorkspace} onStarted={setConversationId} />
        )}
      </div>
    </aside>
  );
}

function MessageBox({ placeholder, pending, error, onSend }: { placeholder: string; pending: boolean; error: Error | null; onSend: (text: string, done: () => void) => void }) {
  const [text, setText] = useState('');
  const submit = () => text.trim() && onSend(text, () => setText(''));
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 rounded-lg border border-border bg-panel p-2">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">Enter envia · Shift+Enter quebra linha</span>
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim() || pending}>
          Enviar
        </Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function NewConversation({ workspaceId, onStarted }: { workspaceId: string; onStarted: (id: string) => void }) {
  const start = useStartConversation(workspaceId);
  const context = usePageContext();
  const send = (message: string, done: () => void) =>
    start.mutate(
      { message, context },
      {
        onSuccess: (agent) => {
          done();
          onStarted(agent.id);
        },
      },
    );

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="space-y-2">
        <p className="text-sm">Oi! Eu ajudo a montar agentes e workflows, explico o que aconteceu nas execuções e acompanho o consumo.</p>
        <p className="text-xs text-muted">Toda mudança aparece como uma proposta, e só acontece quando você clica em Aplicar.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => send(suggestion, () => undefined)}
            disabled={start.isPending}
            className="rounded-md border border-border px-3 py-2 text-left text-xs text-gray-300 hover:border-accent/60 hover:text-white disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div className="mt-auto">
        <MessageBox placeholder="O que você quer montar ou entender?" pending={start.isPending} error={start.error} onSend={send} />
      </div>
    </div>
  );
}

function OrbiConversation({ agentId, workspaceId, onAnswering }: { agentId: string; workspaceId: string; onAnswering: (answering: boolean) => void }) {
  const agent = useAgent(agentId);
  const answering = agent.data?.status === 'RUNNING' || agent.data?.status === 'PREPARING';
  useEffect(() => {
    onAnswering(answering);
    return () => onAnswering(false);
  }, [answering, onAnswering]);
  const proposals = useProposals(agentId);
  const sendMessage = useSendToConversation(agentId);
  const context = usePageContext();

  if (agent.error) return <ErrorText error={agent.error} />;
  if (!agent.data) return <p className="text-sm text-muted">Carregando...</p>;

  const renderEvent = (event: AgentEvent) => {
    // Órbi works in a scratch folder; that detail is noise in the chat.
    if (event.type === 'status' && event.data.message.startsWith('Pasta de trabalho')) return <></>;
    if (event.type !== 'proposal') return undefined;
    const proposal = proposals.data?.find((entry) => entry.id === event.data.proposalId);
    return proposal ? <ProposalCard proposal={proposal} workspaceId={workspaceId} /> : <p className="text-xs text-muted">{event.data.summary}</p>;
  };

  return (
    <Conversation
      agent={agent.data}
      speaker="Órbi"
      renderEvent={renderEvent}
      composer={
        <MessageBox
          placeholder="Pergunte ou peça uma mudança..."
          pending={sendMessage.isPending}
          error={sendMessage.error}
          onSend={(message, done) => sendMessage.mutate({ message, context }, { onSuccess: done })}
        />
      }
    />
  );
}
