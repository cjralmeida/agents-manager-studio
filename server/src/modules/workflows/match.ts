import { createHash } from 'node:crypto';
import { dependencyRefs } from '../boards/dependencies.js';
import type { BoardField, BoardItem } from '../boards/types.js';

/** What a board-triggered workflow looks for on the board. */
export interface TaskRule {
  /** Field id -> accepted option ids; empty lists are ignored. */
  fieldFilters: Record<string, string[]>;
  /** Accepted repository paths; empty accepts all. */
  repositories: string[];
  /** Column watched (already resolved to the board's "todo" column when not set). */
  columnId: string | null;
  onlyUnassigned: boolean;
}

export function matchesRule(item: BoardItem, rule: TaskRule) {
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
export function pickTasks(items: BoardItem[], fields: BoardField[], rule: TaskRule) {
  return items
    .filter((item) => matchesRule(item, rule))
    .sort((a, b) => priorityRank(a, fields) - priorityRank(b, fields) || a.updatedAt.localeCompare(b.updatedAt));
}

/** Message describing a task for an agent; the server appends the board README after it. */
export function taskPrompt(item: BoardItem, instructions: string) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  const link = [item.url, `id no quadro: ${item.id}`].filter(Boolean).join(' — ');
  const parts = [`Resolva a tarefa ${ref}: ${item.title}`, link, '', item.body.trim()];
  if (instructions.trim()) parts.push('', '---', 'Instruções extras:', instructions.trim());
  return parts.join('\n').trim();
}

/**
 * Open tasks in the "blocked" column that wait for a decision: the ones with a "Depende de:" line only wait for their
 * dependencies (the Studio releases them), so they are left out.
 */
export function awaitingDecision(items: BoardItem[], blockedColumnId: string, repositories: string[]) {
  return items.filter(
    (item) =>
      item.columnId === blockedColumnId &&
      !item.isClosed &&
      Boolean(item.repository) &&
      dependencyRefs(item.body).length === 0 &&
      (repositories.length === 0 || repositories.some((path) => path.toLowerCase() === item.repository!.toLowerCase())),
  );
}

/** Message for an agent that studies a task waiting for a decision and decides it with the user. */
export function decisionPrompt(item: BoardItem) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  const link = [item.url, `id no quadro: ${item.id}`].filter(Boolean).join(' — ');
  return [
    `A tarefa ${ref} está em "Aguardando aprovação" e precisa de uma decisão: ${item.title}`,
    link,
    'Estude a tarefa e decida com o usuário; só mova o card depois da decisão dele.',
    '',
    item.body.trim(),
  ].join('\n');
}

const FEATURE_ID = /\[(FUNC-\d+)\]/i;

/** "FUNC-012" from a task titled "[FUNC-012] Backend — ...", or null. */
export function featureIdOf(title: string) {
  return FEATURE_ID.exec(title)?.[1]?.toUpperCase() ?? null;
}

export interface ReadyFeature {
  featureId: string;
  /** Open tasks of the feature, all in the homologation column. */
  tasks: BoardItem[];
  /** Changes when tasks or their descriptions change (e.g. a report appended), so a feature is not tested twice as is. */
  signature: string;
}

/** Features whose open tasks (not done nor closed) are all in homologation; tasks of other repositories are ignored. */
export function featuresReady(
  items: BoardItem[],
  input: { homologationColumnId: string; doneColumnId: string | null; repositories: string[] },
): ReadyFeature[] {
  const accepts = (item: BoardItem) =>
    input.repositories.length === 0 || input.repositories.some((path) => path.toLowerCase() === (item.repository ?? '').toLowerCase());
  const groups = new Map<string, BoardItem[]>();
  for (const item of items) {
    const featureId = featureIdOf(item.title);
    if (!featureId || item.isClosed || item.columnId === input.doneColumnId || !accepts(item)) continue;
    groups.set(featureId, [...(groups.get(featureId) ?? []), item]);
  }
  return [...groups.entries()]
    .filter(([, tasks]) => tasks.every((task) => task.columnId === input.homologationColumnId))
    .map(([featureId, tasks]) => {
      const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
      const signature = createHash('sha256')
        .update(sorted.map((task) => `${task.id}\n${task.body}`).join('\n---\n'))
        .digest('hex')
        .slice(0, 32);
      return { featureId, tasks: sorted, signature };
    })
    .sort((a, b) => a.featureId.localeCompare(b.featureId));
}

/** Message for the agent that tests a whole feature: every task with its full description. */
export function featurePrompt(feature: ReadyFeature) {
  const tasks = feature.tasks.map((task) => {
    const ref = task.repository && task.number ? `${task.repository}#${task.number}` : task.id;
    return [`## ${task.title}`, `Tarefa: ${ref} (id ${task.id})${task.url ? ` — ${task.url}` : ''}`, '', task.body.trim()].join('\n');
  });
  return [`Teste em homologação a funcionalidade ${feature.featureId} inteira. Todas as tarefas dela estão em homologação:`, ...tasks].join(
    '\n\n',
  );
}
