import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Agent, type AgentEvent, useAgentEvents, useSendAgentMessage, LIVE_STATUSES } from '../../api/agents';
import { formatTime } from '../../lib/time';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { QuestionCard } from './QuestionCard';

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [count, agent.status]);

  return (
    <div className="flex flex-col gap-3">
      <ErrorText error={events.error} />
      <ol className="space-y-3">
        {events.data?.map((event) => (
          <li key={event.id}>
            {renderEvent?.(event) ?? <EventItem event={event} speaker={speaker} />}
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

/** Context added to messages for Órbi ("[Contexto: ...]") is for the assistant, not for display. */
const withoutContext = (text: string) => text.replace(/\n\n\[Contexto: [^\]]*\]$/, '');

function EventItem({ event, speaker }: { event: AgentEvent; speaker: string }) {
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
          <p className="text-sm whitespace-pre-wrap">{withoutContext(event.data.text)}</p>
        </div>
      );
    case 'assistant_text':
      return (
        <div className="max-w-[85%] rounded-lg border border-border bg-panel px-3 py-2">
          <div className="mb-1 flex justify-between gap-4 text-xs text-muted">
            <span>{speaker}</span>
            {time}
          </div>
          <p className="text-sm whitespace-pre-wrap">{event.data.text}</p>
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

  const submit = () => {
    if (!text.trim()) return;
    send.mutate(text, { onSuccess: () => setText('') });
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
  };

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 rounded-lg border border-border bg-panel p-3">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder={
          agent.status === 'RUNNING' ? 'Mensagem para corrigir o rumo enquanto ele trabalha...' : 'Peça ajustes ou uma nova tarefa...'
        }
        className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted">Ctrl+Enter envia</span>
        <div className="flex items-center gap-3">
          <ErrorText error={send.error} />
          <Button type="submit" variant="primary" disabled={!text.trim() || send.isPending}>
            Enviar
          </Button>
        </div>
      </div>
    </form>
  );
}
