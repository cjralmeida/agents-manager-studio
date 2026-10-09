import type { BoardOption, StatusMap, StatusRole } from './types.js';

/** Checked in this order, so "Aguardando aprovação" is not taken as "A fazer" and "Em revisão" not as "Em andamento". */
const ROLE_PATTERNS: [StatusRole, RegExp][] = [
  ['blocked', /aprova|bloque|blocked|on hold|impedid|approval/],
  ['done', /conclu|done|feito|finaliz|closed|fechad|entregue/],
  ['homologation', /homolog|staging|\bhom\b/],
  ['review', /valida|revis|review|\bqa\b|teste/],
  ['inProgress', /andamento|progress|doing|fazendo|desenvolv|executand/],
  ['todo', /a fazer|to ?do|backlog|abert|\bopen\b|pronto|ready|novo|\bnew\b/],
];

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Role suggested by a column name alone (no fallback), or null. */
export function roleFromName(name: string): StatusRole | null {
  return ROLE_PATTERNS.find(([, pattern]) => pattern.test(normalize(name)))?.[0] ?? null;
}

/** Guesses which column plays each role from the column names; first and last columns are the fallback for todo/done. */
export function detectStatusMap(columns: BoardOption[]): StatusMap {
  const map: StatusMap = {};
  const taken = new Set<string>();

  for (const [role, pattern] of ROLE_PATTERNS) {
    const column = columns.find((option) => !taken.has(option.id) && pattern.test(normalize(option.name)));
    if (column) {
      map[role] = column.id;
      taken.add(column.id);
    }
  }

  const free = columns.filter((option) => !taken.has(option.id));
  if (!map.todo && free[0]) map.todo = free.shift()!.id;
  if (!map.done && free.at(-1)) map.done = free.pop()!.id;
  return map;
}
