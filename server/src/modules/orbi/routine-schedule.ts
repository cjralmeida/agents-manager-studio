import type { OrbiRoutine } from '../../generated/prisma/client.js';

/** When a routine is due and the message Órbi gets for it (no database here: see routines.ts). */

export type RoutineMode = 'auto' | 'assistant';

/** A daily time missed by more than this (the computer was off) is skipped until the next day. */
const DAILY_LATE_MS = 3 * 60 * 60_000;
/** America/Sao_Paulo has no daylight saving time: UTC−3 all year. */
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60_000;

/** Today's run time (HH:MM, São Paulo) that is due: passed, not run since, and not missed by hours. */
export function dueDailyTime(dailyAt: string[], lastRunAt: Date | null, createdAt: Date, now = new Date()) {
  const local = new Date(now.getTime() - SAO_PAULO_OFFSET_MS);
  const since = lastRunAt ?? createdAt;
  let due: string | null = null;
  for (const time of dailyAt) {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) continue;
    const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(match[1]), Number(match[2])) + SAO_PAULO_OFFSET_MS;
    if (at <= now.getTime() && now.getTime() - at < DAILY_LATE_MS && since.getTime() < at) due = time;
  }
  return due;
}

export function dueByInterval(everyMinutes: number | null, lastRunAt: Date | null, now = new Date()) {
  return Boolean(everyMinutes && (!lastRunAt || now.getTime() - lastRunAt.getTime() >= everyMinutes * 60_000));
}

// ---------------------------------------------------------------- the message Órbi gets

const MODE_RULES: Record<RoutineMode, string> = {
  auto: [
    'Modo AUTOMÁTICO: resolva você mesmo, com as suas ferramentas, seguindo as instruções da rotina e a OPERAÇÃO DO DIA A DIA. Não pergunte nada ao usuário (sem AskUserQuestion).',
    'Só não decida sozinho: apagar coisas, credenciais e segredos, gastos e mudança grande de escopo ou de regra de negócio. Isso vira uma decisão para o usuário com studio_flag (summary, details e options).',
  ].join('\n'),
  assistant: [
    'Modo ASSISTENTE: investigue à vontade (consultar é livre), mas não mude nada.',
    'Para cada ponto que precisa de ação, deixe uma decisão para o usuário com studio_flag: summary em uma frase, details com o contexto e options com 2 a 4 opções curtas (a recomendada primeiro, terminando em "(recomendado)"). Não use AskUserQuestion.',
    'Quando o usuário escolher, a escolha chega nesta conversa como "[Decisão do usuário]" e aí você executa.',
  ].join('\n'),
};

export function routineMessage(routine: Pick<OrbiRoutine, 'name' | 'mode' | 'instructions' | 'workspaceIds'>, workspaces: { name: string }[], reasons: string[], eventLines: string[]) {
  const mode = routine.mode === 'auto' ? 'auto' : 'assistant';
  return [
    `[Rotina "${routine.name}" · ${mode === 'auto' ? 'Automático' : 'Assistente'}] Workspaces: ${routine.workspaceIds.length === 0 ? 'todos' : workspaces.map((workspace) => workspace.name).join(', ')}.`,
    ...(reasons.length > 0 ? [`Por que agora: ${reasons.join('; ')}.`] : []),
    ...(eventLines.length > 0 ? ['', 'O que aconteceu:', ...eventLines] : []),
    '',
    routine.instructions.trim()
      ? `Instruções da rotina:\n${routine.instructions.trim()}`
      : 'Instruções da rotina: nenhuma. Veja studio_pending e studio_overview desses workspaces e cuide do que precisar.',
    '',
    MODE_RULES[mode],
    'Termine com um resumo curto: uma linha por item (o que viu e o que fez ou deixou para decisão). Se não houver nada a fazer, diga só "Nada a fazer".',
  ].join('\n');
}

