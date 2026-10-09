import { prisma } from '../../db.js';
import type { TaskBoard } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import type { BoardModel } from './model.js';
import { getModel, getWorkspaceModel } from './model-store.js';
import { type ModelMap, fixedColumnOf } from './model-sync.js';
import { boardContext, findBoard, moveItem } from './service.js';
import { GITHUB_COLORS } from './template.js';
import type { BoardItem } from './types.js';

/**
 * All workspace tasks on one board: every board follows the same model, so its columns and fields are the model's.
 * Provider ids are translated to model ids through each board's map.
 */

type Provider = 'GITHUB' | 'GITLAB';

/** Provider column of a board -> model column. */
function modelColumnOf(board: TaskBoard, model: BoardModel, columnId: string | null) {
  if (!columnId) return null;
  if (board.provider === 'STUDIO') return columnId;
  const fixed = model.columns.find((column) => fixedColumnOf(column, board.provider as Provider) === columnId);
  if (fixed) return fixed.id;
  return (board.modelMap as unknown as ModelMap | null)?.columns[columnId] ?? null;
}

function modelFieldsOf(board: TaskBoard, fields: Record<string, string>) {
  if (board.provider === 'STUDIO') return fields;
  const map = board.modelMap as unknown as ModelMap | null;
  const result: Record<string, string> = {};
  for (const [fieldId, optionId] of Object.entries(fields)) {
    const field = map?.fields[fieldId];
    const option = field?.options[optionId];
    if (field && option) result[field.model] = option;
  }
  return result;
}

export interface OverviewItem extends BoardItem {
  /** Unique over all workspaces: "<workspaceId>:<item id>". */
  id: string;
  itemId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  /** Other workspaces whose board has this same task (it is shown once). */
  alsoIn: string[];
}

export async function listAllTasks(userId: string) {
  const model = await getModel(userId);
  const boards = await prisma.taskBoard.findMany({
    where: { workspace: { ownerId: userId, isIgnored: false, missingAt: null } },
    include: { workspace: { select: { name: true } } },
    orderBy: { workspace: { name: 'asc' } },
  });

  const items: OverviewItem[] = [];
  const byKey = new Map<string, OverviewItem>();
  const excluded: { workspaceId: string; workspaceName: string; reason: string }[] = [];

  for (const board of boards) {
    const workspaceName = board.workspace.name;
    if (board.provider !== 'STUDIO' && board.modelStatus === 'pending') {
      excluded.push({ workspaceId: board.workspaceId, workspaceName, reason: 'O quadro ainda não foi convertido para o modelo.' });
      continue;
    }
    let context;
    try {
      context = await boardContext(board.workspaceId);
    } catch (error) {
      excluded.push({ workspaceId: board.workspaceId, workspaceName, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const item of context.snapshot.items) {
      // The same issue can sit on two boards (e.g. one GitHub issue in two projects): it is listed once.
      const key = item.url ?? `${board.provider}:${board.host}:${board.externalId}:${item.id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.alsoIn.push(workspaceName);
        continue;
      }
      const entry: OverviewItem = {
        ...item,
        id: `${board.workspaceId}:${item.id}`,
        itemId: item.id,
        workspaceId: board.workspaceId,
        workspaceName,
        projectId: context.projectOf(item),
        columnId: modelColumnOf(board, model, item.columnId),
        fields: modelFieldsOf(board, item.fields),
        alsoIn: [],
      };
      byKey.set(key, entry);
      items.push(entry);
    }
  }

  return {
    columns: model.columns.map((column) => ({ id: column.id, name: column.name, color: GITHUB_COLORS[column.color], description: column.description || null })),
    fields: model.fields.map((field) => ({
      id: field.id,
      name: field.name,
      options: field.options.map((option) => ({ id: option.id, name: option.name, color: GITHUB_COLORS[option.color], description: option.description || null })),
    })),
    statusMap: Object.fromEntries(model.columns.filter((column) => column.role).map((column) => [column.role!, column.id])),
    items,
    excluded,
  };
}

/** Moves a task to a model column, translated to the column of its own board. */
export async function moveOverviewTask(workspaceId: string, itemId: string, modelColumnId: string) {
  const board = await findBoard(workspaceId);
  const model = await getWorkspaceModel(workspaceId);
  const column = model.columns.find((entry) => entry.id === modelColumnId);
  if (!column) throw new HttpError(404, 'Coluna não encontrada no modelo.');
  let target: string | undefined;
  if (board.provider === 'STUDIO') target = column.id;
  else {
    target =
      fixedColumnOf(column, board.provider as Provider) ??
      Object.entries((board.modelMap as unknown as ModelMap | null)?.columns ?? {}).find(([, modelId]) => modelId === column.id)?.[0];
  }
  if (!target) throw new HttpError(422, 'O quadro deste workspace não tem essa coluna. Sincronize-o com o modelo.');
  await moveItem(workspaceId, itemId, target);
}
