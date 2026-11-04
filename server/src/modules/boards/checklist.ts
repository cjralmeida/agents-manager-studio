import { prisma } from '../../db.js';

export interface ChecklistCheck {
  /** CA code or DoD hash key the row belongs to. */
  code: string;
  /** Display name of who ticked it (a user's name or an agent login). */
  checkedBy: string;
  checkedByKind: 'user' | 'agent';
  /** ISO date. */
  checkedAt: string;
}

function toCheck(row: { code: string; checkedBy: string; checkedByKind: string; checkedAt: Date }): ChecklistCheck {
  return {
    code: row.code,
    checkedBy: row.checkedBy,
    checkedByKind: row.checkedByKind === 'agent' ? 'agent' : 'user',
    checkedAt: row.checkedAt.toISOString(),
  };
}

/** The ticked checklist lines of a task (CA / DoD), oldest first. */
export async function listChecklist(workspaceId: string, itemId: string): Promise<ChecklistCheck[]> {
  const rows = await prisma.taskChecklistCheck.findMany({
    where: { workspaceId, itemId },
    orderBy: { checkedAt: 'asc' },
  });
  return rows.map(toCheck);
}

/** Tick (or untick) one checklist line, recording who did it. Unticking removes the row. */
export async function setChecklistCheck(
  workspaceId: string,
  itemId: string,
  code: string,
  opts: { checked: boolean; by: string; kind: 'user' | 'agent' },
): Promise<ChecklistCheck | null> {
  if (!opts.checked) {
    await prisma.taskChecklistCheck.deleteMany({ where: { workspaceId, itemId, code } });
    return null;
  }
  const row = await prisma.taskChecklistCheck.upsert({
    where: { workspaceId_itemId_code: { workspaceId, itemId, code } },
    create: { workspaceId, itemId, code, checkedBy: opts.by, checkedByKind: opts.kind },
    update: { checkedBy: opts.by, checkedByKind: opts.kind, checkedAt: new Date() },
  });
  return toCheck(row);
}
