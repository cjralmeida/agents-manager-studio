import { prisma } from '../../db.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { getModel } from './model-store.js';
import { boardContext, moveItem } from './service.js';
import type { BoardItem } from './types.js';
import { modelLayout } from './unified.js';

/**
 * All workspace tasks on one board. Every workspace board already speaks the model (its sources are translated),
 * so this only joins the workspaces.
 */

export interface OverviewItem extends BoardItem {
  /** Unique over all workspaces: "<workspaceId>:<task id>". */
  id: string;
  /** Task id on its workspace board. */
  itemId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  /** Other workspaces whose board has this same task (it is shown once). */
  alsoIn: string[];
}

export async function listAllTasks(userId: string) {
  const model = await getModel(userId);
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId: userId, ...(await visibleWorkspaceFilter(userId)), isIgnored: false, missingAt: null, taskBoards: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const items: OverviewItem[] = [];
  const byKey = new Map<string, OverviewItem>();
  const excluded: { workspaceId: string; workspaceName: string; reason: string }[] = [];

  for (const workspace of workspaces) {
    let context;
    try {
      context = await boardContext(workspace.id);
    } catch (error) {
      excluded.push({ workspaceId: workspace.id, workspaceName: workspace.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const source of context.excluded) {
      excluded.push({ workspaceId: workspace.id, workspaceName: workspace.name, reason: `${source.title}: ${source.reason}` });
    }
    for (const item of context.snapshot.items) {
      // The same issue can sit on two boards (e.g. one GitHub issue in two projects): it is listed once.
      const key = item.url ?? `${workspace.id}:${item.id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.alsoIn.push(workspace.name);
        continue;
      }
      const entry: OverviewItem = {
        ...item,
        id: `${workspace.id}:${item.id}`,
        itemId: item.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        projectId: context.projectOf(item),
        alsoIn: [],
      };
      byKey.set(key, entry);
      items.push(entry);
    }
  }

  const layout = modelLayout(model);
  return { columns: layout.columns, fields: layout.fields, statusMap: layout.statusMap, items, excluded };
}

/** Moves a task of the all-workspaces board to a model column (the workspace board translates it to its source). */
export async function moveOverviewTask(workspaceId: string, itemId: string, modelColumnId: string) {
  await moveItem(workspaceId, itemId, modelColumnId);
}
