import { type BoardOption, STATUS_ROLES, type StatusMap, type StatusRole } from './types.js';

/** Checked in this order, so "Aguardando aprovação" is not taken as "A fazer" and "Em revisão" not as "Em andamento". */
const ROLE_PATTERNS: [StatusRole, RegExp][] = [
  ['blocked', /aprova|bloque|blocked|on hold|impedid|approval/],
  ['done', /conclu|done|feito|finaliz|closed|fechad|entregue/],
  ['review', /valida|revis|review|homolog|\bqa\b|teste/],
  ['inProgress', /andamento|progress|doing|fazendo|desenvolv|executand/],
  ['todo', /a fazer|to ?do|backlog|abert|\bopen\b|pronto|ready|novo|\bnew\b/],
];

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
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

/** Keeps only roles pointing to existing columns. */
export function sanitizeStatusMap(value: unknown, columns: BoardOption[]): StatusMap {
  const ids = new Set(columns.map((column) => column.id));
  const map: StatusMap = {};
  if (value && typeof value === 'object') {
    for (const role of STATUS_ROLES) {
      const id = (value as Record<string, unknown>)[role];
      if (typeof id === 'string' && ids.has(id)) map[role] = id;
    }
  }
  return map;
}
