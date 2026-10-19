import { type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Agent, type AgentEvent, type MessageAttachment, useAgentEvents, useSendAgentMessage, LIVE_STATUSES } from '../../api/agents';
import { formatTime } from '../../lib/time';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { ImagePreviews, LinkedText, QuestionCard } from './QuestionCard';
import { ACCEPTED, AttachmentList, useAttachments } from '../orbi/Attachments';

interface ConversationProps {
  agent: Agent;
  /** Who answers ("Agente", "Órbi"). */
  speaker?: string;
  /** Renders event types the timeline does not know (e.g. Órbi proposals). */
  renderEvent?: (event: AgentEvent) => ReactNode | undefined;
  /** Replaces the default message box. */
  composer?: ReactNode;
}

export function Conversation({ agent, speaker = 'Agente', renderEvent, composer }: ConversationProps) {
  const events = useAgentEvents(agent.id, LIVE_STATUSES.includes(agent.status));
  const bottomRef = useRef<HTMLDivElement>(null);
  const count = events.data?.length ?? 0;

  // Opening a conversation (or switching to another agent) jumps to its last message; new messages scroll smoothly.
  const shownAgent = useRef<string | null>(null);
  useEffect(() => {
    const opening = shownAgent.current !== agent.id;
    if (count === 0) return;
    shownAgent.current = agent.id;
    // To the very end of the page (the message box below the conversation included).
    const page = bottomRef.current?.closest('main');
    if (page) page.scrollTo({ top: page.scrollHeight, behavior: opening ? 'auto' : 'smooth' });
    else bottomRef.current?.scrollIntoView({ behavior: opening ? 'auto' : 'smooth', block: 'end' });
  }, [agent.id, count, agent.status]);

  return (
    <div className="flex flex-col gap-3">
      <ErrorText error={events.error} />
      <ol className="space-y-3">
        {events.data?.map((event) => (
          <li key={event.id}>
            {renderEvent?.(event) ?? <EventItem event={event} speaker={speaker} agentId={agent.id} />}
          </li>
        ))}
      </ol>

      {agent.paused && <p className="text-sm text-muted">Pausado: o workflow deste agente está desligado. Ele continua de onde parou quando o workflow for religado.</p>}
      {agent.status === 'RUNNING' && !agent.paused && <p className="animate-pulse text-sm text-muted">{speaker === 'Agente' ? 'O agente está trabalhando...' : `${speaker} está pensando...`}</p>}
      {agent.status === 'PREPARING' && <p className="animate-pulse text-sm text-muted">Preparando a cópia do projeto...</p>}
      {agent.status === 'WAITING_INPUT' && agent.pendingQuestion && (
        <QuestionCard agentId={agent.id} questions={agent.pendingQuestion} />
      )}

      <div ref={bottomRef} />
      {!['CANCELLED', 'FINALIZING'].includes(agent.status) && (composer ?? <Composer agent={agent} />)}
    </div>
  );
}

/**
 * Context added to messages for Órbi ("[Contexto: ...]") and the list of attachments ("[Anexos do usuário]", shown as
 * the files themselves) are for the assistant, not for display.
 */
const withoutContext = (text: string) => text.replace(/\n\n\[Contexto: [^\]]*\]$/, '').replace(/(^|\n\n)\[Anexos do usuário\][\s\S]*$/, '');

/** Images and audios sent with a message, served from the agent's folder. */
function MessageAttachments({ agentId, attachments }: { agentId: string; attachments: MessageAttachment[] }) {
  const url = (attachment: MessageAttachment) => `/api/agents/${agentId}/files/${attachment.path.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <div className="mt-2 space-y-2">
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <a key={attachment.path} href={url(attachment)} target="_blank" rel="noreferrer" title={`${attachment.name} — abrir em tamanho cheio`} className="block w-fit">
            <img src={url(attachment)} alt={attachment.name} className="max-h-64 max-w-full rounded border border-border" />
          </a>
        ) : (
          <div key={attachment.path} className="space-y-1">
            <audio controls preload="metadata" src={url(attachment)} className="h-9 w-full max-w-xs" />
            {attachment.transcript && <p className="text-xs text-muted italic">“{attachment.transcript}”</p>}
          </div>
        ),
      )}
    </div>
  );
}

function EventItem({ event, speaker, agentId }: { event: AgentEvent; speaker: string; agentId: string }) {
  const time = <span className="text-xs text-muted">{formatTime(event.createdAt)}</span>;

  switch (event.type) {
    case 'user_message':
      // Messages the Studio sends on the user's behalf (e.g. a proposal was applied).
      if (event.data.text.startsWith('[Studio] ')) {
        return <p className="text-center text-xs text-muted">{event.data.text.slice('[Studio] '.length)}</p>;
      }
      return (
        <div className="ml-auto max-w-[85%] rounded-lg bg-accent/15 px-3 py-2">
          <div className="mb-1 flex justify-between gap-4 text-xs text-muted">
            <span>Você</span>
            {time}
          </div>
          {withoutContext(event.data.text) && <p className="text-sm whitespace-pre-wrap">{withoutContext(event.data.text)}</p>}
          {event.data.attachments?.length ? <MessageAttachments agentId={agentId} attachments={event.data.attachments} /> : null}
        </div>
      );
    case 'assistant_text':
      return (
        <div className="max-w-[85%] rounded-lg border border-border bg-panel px-3 py-2">
          <div className="mb-1 flex justify-between gap-4 text-xs text-muted">
            <span>{speaker}</span>
            {time}
          </div>
          <p className="text-sm break-words whitespace-pre-wrap">
            <LinkedText text={event.data.text} />
          </p>
          <ImagePreviews text={event.data.text} />
        </div>
      );
    case 'tool_use':
      return (
        <div className="flex items-center gap-2 font-mono text-xs text-muted">
          <span className="rounded bg-border px-1.5 py-0.5 text-gray-300">{event.data.name}</span>
          <span className="truncate">{event.data.summary}</span>
        </div>
      );
    case 'question':
      return (
        <div className="text-sm text-amber-300">
          Pergunta: {event.data.questions.map((question) => question.question).join(' · ')}
        </div>
      );
    case 'answer':
      return (
        <div className="ml-auto max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 text-sm">
          {Object.entries(event.data.answers).map(([question, answer]) => (
            <p key={question}>
              <span className="text-muted">{question}</span> <strong>{answer}</strong>
            </p>
          ))}
        </div>
      );
    case 'turn_end':
      return event.data.isError ? (
        <p className="text-sm text-red-300">O turno terminou com erro: {event.data.text}</p>
      ) : (
        <hr className="border-border" />
      );
    case 'status':
      return <p className="text-center text-xs text-muted">{event.data.message}</p>;
    case 'error':
      return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">{event.data.message}</p>;
    case 'completed':
      return (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Concluído.{' '}
          <a href={event.data.prUrl} target="_blank" rel="noreferrer" className="underline">
            Abrir PR/MR
          </a>
        </p>
      );
  }
}

function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const send = useSendAgentMessage(agent.id);
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (text.trim() || attachments.items.length > 0) && !send.isPending;

  const submit = () => {
    if (!canSend) return;
    send.mutate(
      { text, attachments: attachments.uploads() },
      {
        onSuccess: () => {
          setText('');
          attachments.clear();
        },
      },
    );
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
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(event.dataTransfer.files);
      }}
      className="sticky bottom-0 rounded-lg border border-border bg-panel p-3"
    >
      <AttachmentList items={attachments.items} onRemove={attachments.remove} />
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        rows={3}
        placeholder={
          agent.status === 'RUNNING' ? 'Mensagem para corrigir o rumo enquanto ele trabalha...' : 'Peça ajustes ou uma nova tarefa...'
        }
        className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
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
          <Button type="button" size="sm" onClick={() => fileInput.current?.click()} title="Anexar imagens (ou cole com Ctrl+V / arraste)">
            Anexar
          </Button>
          <span className="text-xs text-muted">Ctrl+Enter envia · cole ou arraste imagens</span>
        </div>
        <div className="flex items-center gap-3">
          {attachments.error && <span className="text-xs text-red-300">{attachments.error}</span>}
          <ErrorText error={send.error} />
          <Button type="submit" variant="primary" disabled={!canSend}>
            Enviar
          </Button>
        </div>
      </div>
    </form>
  );
}
