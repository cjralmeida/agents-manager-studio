/**
 * The signed comments agents leave on tasks: a fixed header (verdict, agent, step, local date and time, task) over the
 * agent's text, so the task's history reads as a timeline of who said what and when.
 */

export const COMMENT_KINDS = ['aprovado', 'reprovado', 'correcao', 'decisao', 'publicado', 'observacao'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

const BADGES: Record<CommentKind, string> = {
  aprovado: '🟢 **Aprovado**',
  reprovado: '🔴 **Reprovado**',
  correcao: '🛠️ **Correção**',
  decisao: '🧭 **Decisão**',
  publicado: '🚀 **Publicado em HOM**',
  observacao: '💬 **Observação**',
};

const TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';

export interface CommentAuthor {
  /** The workspace agent (profile) name, e.g. "code-guardian"; the execution title when it has none. */
  agentName: string;
  /** The workflow step, e.g. "Revisar" (from the execution title "Revisar: ..."). */
  step: string | null;
  executionId: string;
}

/** "Revisar: [FUNC-029] API — ..." → "Revisar". */
export function stepOfTitle(title: string) {
  return /^([^:[]{2,40}):\s+\S/.exec(title)?.[1]?.trim() ?? null;
}

export function formatComment(input: { kind: CommentKind; text: string; author: CommentAuthor; taskRef: string | null; at?: Date }) {
  const at = (input.at ?? new Date()).toLocaleString('pt-BR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const who = [BADGES[input.kind], `🤖 **${input.author.agentName}**`, input.author.step].filter(Boolean).join(' · ');
  const when = [`🕒 ${at.replace(', ', ' ')} (Brasília)`, input.taskRef?.replace(/^.*\//, '')].filter(Boolean).join(' · ');
  return [who, when, '', '---', '', input.text.trim(), '', `<sub>Agents Manager Studio · execução ${input.author.executionId.slice(0, 8)}</sub>`].join('\n');
}
