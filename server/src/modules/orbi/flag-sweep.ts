import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { closedOffBoard, refResolver } from '../boards/dependencies.js';
import type { BoardItem, StatusMap } from '../boards/types.js';

/**
 * Decisions Órbi left about a task stop mattering once the task is done: a decision answered after the task passed
 * (e.g. "keep trying" on a task approved the night before) only confuses its history. They are dismissed by themselves.
 */

/** Task refs ("repo#12", "group/sub/repo#3") a decision names in its summary. */
export function flagTaskRefs(summary: string): string[] {
  return [...new Set([...summary.matchAll(/([\w.-]+(?:\/[\w.-]+)*#\d+)/g)].map((match) => match[1]!))];
}

/** Whether every task the decision names is done (or closed); a decision that names no task is never dismissed. */
export function flagTasksDone(summary: string, items: BoardItem[], statusMap: StatusMap, allOpenListed: string[] = []) {
  const refs = flagTaskRefs(summary);
  if (refs.length === 0) return false;
  const resolve = refResolver(items);
  const closed = closedOffBoard(allOpenListed);
  return refs.every((ref) => {
    const item = resolve(ref);
    return item ? item.isClosed || item.columnId === statusMap.done : closed(ref);
  });
}

/** Dismisses the open decisions of a workspace whose tasks are all done; returns how many. */
export async function dismissDoneTaskFlags(workspaceId: string, board: { items: BoardItem[]; statusMap: StatusMap; allOpenListed?: string[] }) {
  const flags = await prisma.orbiActivity.findMany({ where: { workspaceId, kind: 'flag', resolvedAt: null } });
  const done = flags.filter((flag) => flagTasksDone(flag.summary, board.items, board.statusMap, board.allOpenListed));
  for (const flag of done) {
    const details = (flag.details ?? {}) as Record<string, unknown>;
    await prisma.orbiActivity.update({
      where: { id: flag.id },
      data: { resolvedAt: new Date(), details: { ...details, dismissed: 'A tarefa foi concluída antes da decisão.' } as Prisma.InputJsonValue },
    });
  }
  return done.length;
}
