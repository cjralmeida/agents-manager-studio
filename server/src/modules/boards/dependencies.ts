import type { BoardItem, StatusMap } from './types.js';

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
export function releasableItems(items: BoardItem[], statusMap: StatusMap): BoardItem[] {
  if (!statusMap.blocked || !statusMap.todo) return [];
  const byRef = new Map(items.flatMap((item) => (itemRef(item) ? [[itemRef(item)!.toLowerCase(), item] as const] : [])));
  return items.filter((item) => {
    if (item.columnId !== statusMap.blocked) return false;
    const refs = dependencyRefs(item.body);
    if (refs.length === 0) return false;
    return refs.every((ref) => {
      const dependency = byRef.get(ref.toLowerCase());
      if (!dependency) return false;
      return dependency.isClosed || dependency.columnId === statusMap.done || (Boolean(statusMap.homologation) && dependency.columnId === statusMap.homologation);
    });
  });
}
