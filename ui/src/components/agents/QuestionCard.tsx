import { useState } from 'react';
import { type AgentQuestion, useAnswerAgent } from '../../api/agents';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';

const OTHER = '__other__';

/** The agent's AskUserQuestion: options per question plus a free "Outra resposta". */
export function QuestionCard({ agentId, questions }: { agentId: string; questions: AgentQuestion[] }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answer = useAnswerAgent(agentId);

  const toggle = (question: AgentQuestion, label: string) => {
    const current = selected[question.question] ?? [];
    const next = question.multiSelect
      ? current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label]
      : [label];
    setSelected({ ...selected, [question.question]: next });
  };

  const answers = Object.fromEntries(
    questions.map((question) => {
      const labels = (selected[question.question] ?? []).map((label) =>
        label === OTHER ? (other[question.question] ?? '').trim() : label,
      );
      return [question.question, labels.filter(Boolean).join(', ')];
    }),
  );
  const complete = questions.every((question) => answers[question.question]);

  return (
    <section className="rounded-lg border border-amber-400/50 bg-amber-500/5 p-4 shadow-[0_0_24px_-6px_rgba(251,191,36,0.5)]">
      <h3 className="text-sm font-semibold text-amber-300">O agente precisa de você</h3>
      <div className="mt-3 space-y-4">
        {questions.map((question) => {
          const chosen = selected[question.question] ?? [];
          return (
            <div key={question.question}>
              <p className="text-sm font-medium whitespace-pre-line">
                <LinkedText text={question.question} />
              </p>
              <ImagePreviews text={question.question} />
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => toggle(question, option.label)}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${chosen.includes(option.label) ? 'border-accent bg-accent/10' : 'border-border hover:border-muted'}`}
                  >
                    <div className="font-medium">{option.label}</div>
                    {option.description && <div className="mt-0.5 text-xs text-muted">{option.description}</div>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => toggle(question, OTHER)}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${chosen.includes(OTHER) ? 'border-accent bg-accent/10' : 'border-border hover:border-muted'}`}
                >
                  <div className="font-medium">Outra resposta</div>
                  <div className="mt-0.5 text-xs text-muted">Escrever com suas palavras</div>
                </button>
              </div>
              {chosen.includes(OTHER) && (
                <TextInput
                  className="mt-2"
                  value={other[question.question] ?? ''}
                  onChange={(event) => setOther({ ...other, [question.question]: event.target.value })}
                  placeholder="Sua resposta"
                  autoFocus
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={() => answer.mutate(answers)} disabled={!complete || answer.isPending}>
          {answer.isPending ? 'Enviando...' : 'Responder'}
        </Button>
        <ErrorText error={answer.error} />
      </div>
    </section>
  );
}

const URL_PATTERN = /(https?:\/\/[^\s)>\]]+)/g;
const IMAGE_URL = /\.(png|gif|webp|jpe?g)(\?.*)?$/i;

/** Question text with its links clickable (e.g. the previews an art agent asks the user to approve). */
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_PATTERN).map((part, index) =>
        index % 2 === 1 ? (
          <a key={index} href={part} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The images linked in a question, shown right there; a click opens the full size. */
function ImagePreviews({ text }: { text: string }) {
  const images = [...new Set(text.match(URL_PATTERN) ?? [])].filter((url) => IMAGE_URL.test(url));
  if (images.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" title="Abrir em tamanho cheio" className="block rounded border border-border bg-surface p-1 hover:border-accent">
          <img src={url} alt={url.split('/').pop()} className="max-h-64 max-w-full [image-rendering:pixelated]" />
          <span className="mt-1 block truncate text-[10px] text-muted">{decodeURIComponent(url.split('/').pop() ?? '')}</span>
        </a>
      ))}
    </div>
  );
}
