import type { BoardField, BoardItem, StatusMap } from './types.js';

/**
 * Task dependencies written by the task agent: a task blocked in the "blocked" column carries a line
 * "Depende de: org/repo#12, org/repo#15". When every task it names is delivered, it is released to "todo".
 */

const DEPENDS_LINE = /^\s*(?:[-*]\s*)?\**depende de\**:?\**\s*(.+)$/im;

/** Refs ("repo#12", "group/sub/repo#3") listed on the "Depende de:" line, if any. */
export function dependencyRefs(body: string): string[] {
  const line = DEPENDS_LINE.exec(body)?.[1] ?? '';
  return [...line.matchAll(/([\w.-]+(?:\/[\w.-]+)*#\d+)/g)].map((match) => match[1]!);
}

export const itemRef = (item: Pick<BoardItem, 'repository' | 'number'>) => (item.repository && item.number ? `${item.repository}#${item.number}` : null);

/**
 * Blocked tasks whose dependencies are all delivered: done, closed, or in homologation (merged and published, waiting
 * for the whole feature to be tested — which needs the dependent tasks too). A dependency that is not on the
 * board keeps the task blocked: it may be on another board, or the ref may be wrong.
 */
export function releasableItems(items: BoardItem[], statusMap: StatusMap, fields: BoardField[] = []): BoardItem[] {
  if (!statusMap.blocked || !statusMap.todo) return [];
  const delivered = dependenciesDelivered(items, statusMap);
  // A task that also waits for a decision stays until it is decided (the decision clears the mark).
  const mark = decisionMark(fields);
  return items.filter(
    (item) =>
      item.columnId === statusMap.blocked &&
      dependencyRefs(item.body).length > 0 &&
      !(mark && item.fields[mark.fieldId] === mark.optionId) &&
      delivered(item),
  );
}

/**
 * Tasks in "todo" that are not ready anymore: a dependency on the board is not delivered (e.g. it was sent back from
 * homologation, or the task was put in "todo" too early). They go back to the blocked column, so no agent — of the
 * Studio or outside it — picks them before their dependencies; the release brings them back when it is delivered. A
 * dependency that is not on the board (another board, a docs repository) is not tracked here. Tasks someone is
 * working on are left alone.
 */
export function reblockableItems(items: BoardItem[], statusMap: StatusMap, working: Set<string> = new Set()): BoardItem[] {
  if (!statusMap.blocked || !statusMap.todo) return [];
  const byRef = new Map(items.flatMap((item) => (itemRef(item) ? [[itemRef(item)!.toLowerCase(), item] as const] : [])));
  const delivered = (dependency: BoardItem) =>
    dependency.isClosed || dependency.columnId === statusMap.done || (Boolean(statusMap.homologation) && dependency.columnId === statusMap.homologation);
  return items.filter((item) => {
    if (item.isClosed || item.columnId !== statusMap.todo || working.has(item.id)) return false;
    const onBoard = dependencyRefs(item.body).flatMap((ref) => byRef.get(ref.toLowerCase()) ?? []);
    return onBoard.some((dependency) => !delivered(dependency));
  });
}

/**
 * The field option that marks a task waiting for a decision between an agent and a person ("Decisão" = "Aguardando
 * decisão"), when the board has it.
 */
export function decisionMark(fields: BoardField[]) {
  const field = fields.find((entry) => /^decis/i.test(entry.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  const option = field?.options.find((entry) => /aguard/i.test(entry.name));
  return field && option ? { fieldId: field.id, optionId: option.id, field: field.name, option: option.name } : null;
}

/**
 * Whether every task an item depends on ("Depende de:") is delivered: done, closed, or in homologation. Without the
 * line, it is. A dependency that is not on the board counts as not delivered (it may be on another board, or the ref
 * may be wrong).
 */
export function dependenciesDelivered(items: BoardItem[], statusMap: StatusMap) {
  const byRef = new Map(items.flatMap((item) => (itemRef(item) ? [[itemRef(item)!.toLowerCase(), item] as const] : [])));
  return (item: BoardItem) =>
    dependencyRefs(item.body).every((ref) => {
      const dependency = byRef.get(ref.toLowerCase());
      if (!dependency) return false;
      return dependency.isClosed || dependency.columnId === statusMap.done || (Boolean(statusMap.homologation) && dependency.columnId === statusMap.homologation);
    });
}
