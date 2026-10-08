import type { BoardField, BoardItem } from '../boards/types.js';

/** What a sentinel looks for on the board. */
export interface SentinelRule {
  /** Field id -> accepted option ids; empty lists are ignored. */
  fieldFilters: Record<string, string[]>;
  /** Accepted repository paths; empty accepts all. */
  repositories: string[];
  /** Column watched (already resolved to the board's "todo" column when not set). */
  columnId: string | null;
  onlyUnassigned: boolean;
}

export function matchesRule(item: BoardItem, rule: SentinelRule) {
  if (!rule.columnId || item.columnId !== rule.columnId || item.isClosed) return false;
  // Agents work on a repository, so drafts without one are left to people.
  if (!item.repository) return false;
  if (rule.onlyUnassigned && item.assignees.length > 0) return false;
  if (rule.repositories.length > 0 && !rule.repositories.some((path) => path.toLowerCase() === item.repository!.toLowerCase())) {
    return false;
  }
  return Object.entries(rule.fieldFilters).every(
    ([fieldId, options]) => options.length === 0 || (item.fields[fieldId] !== undefined && options.includes(item.fields[fieldId])),
  );
}

/** Position of the item priority in the "Prioridade/Priority" field (P0 first); unset goes last. */
function priorityRank(item: BoardItem, fields: BoardField[]) {
  const field = fields.find((entry) => /priori/i.test(entry.name));
  const optionId = field ? item.fields[field.id] : undefined;
  const index = field && optionId ? field.options.findIndex((option) => option.id === optionId) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Matching tasks, highest priority first, then the oldest. */
export function pickTasks(items: BoardItem[], fields: BoardField[], rule: SentinelRule) {
  return items
    .filter((item) => matchesRule(item, rule))
    .sort((a, b) => priorityRank(a, fields) - priorityRank(b, fields) || a.updatedAt.localeCompare(b.updatedAt));
}

/** First message of an agent launched for a task; the server appends the board README after it. */
export function taskPrompt(item: BoardItem, instructions: string) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  const parts = [`Resolva a tarefa ${ref}: ${item.title}`, item.url ?? '', '', item.body.trim()];
  if (instructions.trim()) parts.push('', '---', 'Instruções da sentinela:', instructions.trim());
  return parts.join('\n').trim();
}
