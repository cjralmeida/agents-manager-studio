import { type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useMatch } from 'react-router';
import { type AgentEvent, useAgent } from '../../api/agents';
import { type AttachmentUpload, useProposals } from '../../api/assistant';
import { useOrbiConversation, useSendToOrbi } from '../../api/orbi';
import { useWorkspaces } from '../../api/workspaces';
import { Conversation } from '../agents/Conversation';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { Logo } from '../Logo';
import { ACCEPTED, AttachmentList, RecordButton, useAttachments } from './Attachments';
import { ProposalCard } from './ProposalCard';

const SUGGESTIONS = [
  'Como estão os workspaces agora?',
  'Tem algum agente esperando resposta? Responda por mim.',
  'Por que a última execução falhou?',
  'Pause este workspace: deixe as tarefas em andamento terminarem e não pegue novas.',
  'Monte um workflow que documenta, planeja, implementa, testa e publica em homologação.',
];

/** Where the user is, sent with each message so Órbi understands "este workflow", "aqui". */
function usePageContext() {
  const location = useLocation();
  return `página ${location.pathname}${location.search}`;
}

/** The workspace on screen: where a brand-new conversation starts. */
function useScreenWorkspace() {
  const workspaces = useWorkspaces();
  const routeWorkspace = useMatch('/workspaces/:workspaceId/*')?.params.workspaceId ?? null;
  const available = workspaces.data?.filter((workspace) => !workspace.isMissing && !workspace.isIgnored) ?? [];
  return available.find((workspace) => workspace.id === routeWorkspace)?.id ?? available[0]?.id ?? null;
}

/** Órbi: the assistant panel, available from any screen, with the user's one conversation. */
export function OrbiPanel({ onClose, onConversation }: { onClose: () => void; onConversation?: (id: string | null) => void }) {
  const info = useOrbiConversation();
  const current = info.data?.conversationId ?? null;
  // The layout follows the conversation, so the Órbi button can light up while the panel is closed.
  useEffect(() => onConversation?.(current), [current, onConversation]);
  /** Órbi is answering: the panel gets the purple light, like working agents. */
  const [answering, setAnswering] = useState(false);

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
          <p className="text-[11px] text-muted">Opera o Studio com você · as rotinas ficam na página do Órbi</p>
        </div>
        <Link to="/orbi" onClick={onClose} className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:border-accent/60 hover:text-white">
          Abrir página
        </Link>
        <Button size="sm" onClick={onClose}>
          Fechar
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {info.error ? (
          <ErrorText error={info.error} />
        ) : !info.data ? (
          <p className="text-sm text-muted">Carregando...</p>
        ) : current ? (
          <OrbiConversation key={current} agentId={current} onAnswering={setAnswering} />
        ) : (
          <OrbiStart />
        )}
      </div>
    </aside>
  );
}

/** Sends the text and the attached images and audios; done() clears the box once the server took them. */
type SendHandler = (text: string, attachments: AttachmentUpload[], done: () => void) => void;

export function MessageBox({ placeholder, pending, error, onSend }: { placeholder: string; pending: boolean; error: Error | null; onSend: SendHandler }) {
  const [text, setText] = useState('');
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const canSend = (text.trim() || attachments.items.length > 0) && !pending;
  const submit = () =>
    canSend &&
    onSend(text, attachments.uploads(), () => {
      setText('');
      attachments.clear();
    });
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
  const addFiles = (files: Iterable<File>) => {
    for (const file of files) void attachments.add(file, file.name);
  };
  // A screenshot pasted with Ctrl+V becomes an attachment.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };
  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };
  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`sticky bottom-0 rounded-lg border bg-panel p-2 ${dragging ? 'border-accent' : 'border-border'}`}
    >
      <AttachmentList items={attachments.items} onRemove={attachments.remove} />
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED}
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files ?? []);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:border-accent/60 hover:text-white"
            title="Anexar imagens ou áudios (também dá para colar um print ou arrastar arquivos aqui)"
          >
            📎 Anexar
          </button>
          <RecordButton onRecorded={(blob, name, transcript) => void attachments.add(blob, name, transcript)} onError={attachments.setError} />
        </div>
        <span className="hidden text-[11px] text-muted sm:inline">Enter envia · Shift+Enter quebra linha</span>
        <Button type="submit" size="sm" variant="primary" disabled={!canSend}>
          Enviar
        </Button>
      </div>
      {attachments.error && <p className="mt-1 text-xs text-red-300">{attachments.error}</p>}
      <ErrorText error={error} />
    </form>
  );
}

/** Before the first message: what Órbi does, a few suggestions and the box. */
export function OrbiStart() {
  const send = useSendToOrbi();
  const context = usePageContext();
  const workspaceId = useScreenWorkspace() ?? undefined;
  const start: SendHandler = (message, attachments, done) =>
    send.mutate({ message, context, workspaceId, ...(attachments.length > 0 && { attachments }) }, { onSuccess: done });

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="space-y-2">
        <p className="text-sm">Oi! Eu opero o Studio com você: respondo os agentes, acompanho as execuções, mexo no quadro, pauso e retomo workspaces e decido a capacidade.</p>
        <p className="text-xs text-muted">
          Temos uma conversa só: o que você me pede e o que as rotinas me mandam fazer acontece aqui. Criar ou mudar agentes e workflows vira proposta, que só acontece quando você clica em Aplicar.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => start(suggestion, [], () => undefined)}
            disabled={send.isPending}
            className="rounded-md border border-border px-3 py-2 text-left text-xs text-gray-300 hover:border-accent/60 hover:text-white disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div className="mt-auto">
        <MessageBox placeholder="O que você quer montar ou entender?" pending={send.isPending} error={send.error} onSend={start} />
      </div>
    </div>
  );
}

export function OrbiConversation({ agentId, onAnswering }: { agentId: string; onAnswering: (answering: boolean) => void }) {
  const agent = useAgent(agentId);
  const answering = agent.data?.status === 'RUNNING' || agent.data?.status === 'PREPARING';
  useEffect(() => {
    onAnswering(answering);
    return () => onAnswering(false);
  }, [answering, onAnswering]);
  const proposals = useProposals(agentId);
  const sendMessage = useSendToOrbi();
  const context = usePageContext();

  if (agent.error) return <ErrorText error={agent.error} />;
  if (!agent.data) return <p className="text-sm text-muted">Carregando...</p>;

  const renderEvent = (event: AgentEvent) => {
    // Órbi works in a scratch folder; that detail is noise in the chat.
    if (event.type === 'status' && event.data.message.startsWith('Pasta de trabalho')) return <></>;
    if (event.type !== 'proposal') return undefined;
    const proposal = proposals.data?.find((entry) => entry.id === event.data.proposalId);
    return proposal ? <ProposalCard proposal={proposal} workspaceId={agent.data.workspaceId} /> : <p className="text-xs text-muted">{event.data.summary}</p>;
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
          onSend={(message, attachments, done) => sendMessage.mutate({ message, context, ...(attachments.length > 0 && { attachments }) }, { onSuccess: done })}
        />
      }
    />
  );
}
