import { prisma } from '../../db.js';
import { Prisma, type TaskBoard } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { type BoardModel, type ModelInput, type ModelUsage, asStructure, planModel, validateModel } from './model.js';
import { getModel, saveModel } from './model-store.js';
import {
  type ConversionMapping,
  type ModelMap,
  fixedColumnOf,
  followsModel,
  mapByName,
  mappingFromStored,
  planSync,
  statusMapFrom,
  suggestMapping,
} from './model-sync.js';
import { applyModelToLocalTasks } from './local.js';
import { adapterFor, findBoard, forgetSnapshot, linkResponse, loadSnapshot, refOf } from './service.js';
import { type BoardStructure, fieldOrderOf, structureOf, validateStructure } from './structure.js';
import type { BoardSnapshot } from './types.js';

type Provider = 'GITHUB' | 'GITLAB';

// ---------------------------------------------------------------- the model

/** Cards per model column/field/option, over the boards that follow the model (cached reads). */
async function modelUsage(model: BoardModel): Promise<ModelUsage> {
  const usage: ModelUsage = { columns: {}, options: {}, fields: {} };
  const boards = await prisma.taskBoard.findMany({ where: { modelStatus: { not: 'pending' } } });
  for (const board of boards) {
    const snapshot = await loadSnapshot(board, false).catch(() => null);
    if (snapshot && board.provider === 'STUDIO') {
      // Studio boards use the model ids directly.
      for (const item of snapshot.items) {
        if (item.columnId) usage.columns[item.columnId] = (usage.columns[item.columnId] ?? 0) + 1;
        for (const [fieldId, optionId] of Object.entries(item.fields)) {
          usage.fields[fieldId] = (usage.fields[fieldId] ?? 0) + 1;
          usage.options[fieldId] = { ...usage.options[fieldId], [optionId]: (usage.options[fieldId]?.[optionId] ?? 0) + 1 };
        }
      }
      continue;
    }
    const map = board.modelMap as unknown as ModelMap | null;
    if (!snapshot || !map) continue;
    const provider = board.provider as Provider;
    const fixed = new Map(model.columns.map((column) => [fixedColumnOf(column, provider), column.id]));
    for (const item of snapshot.items) {
      const column = item.columnId ? (map.columns[item.columnId] ?? fixed.get(item.columnId as 'open' | 'closed')) : undefined;
      if (column) usage.columns[column] = (usage.columns[column] ?? 0) + 1;
      for (const [fieldId, optionId] of Object.entries(item.fields)) {
        const field = map.fields[fieldId];
        const option = field?.options[optionId];
        if (!field || !option) continue;
        usage.fields[field.model] = (usage.fields[field.model] ?? 0) + 1;
        usage.options[field.model] = { ...usage.options[field.model], [option]: (usage.options[field.model]?.[option] ?? 0) + 1 };
      }
    }
  }
  return usage;
}

export async function getModelState() {
  const model = await getModel();
  const boards = await prisma.taskBoard.findMany({ include: { workspace: { select: { name: true } } }, orderBy: { workspace: { name: 'asc' } } });
  return {
    model,
    usage: await modelUsage(model),
    boards: boards.map((board) => ({
      workspaceId: board.workspaceId,
      workspaceName: board.workspace.name,
      provider: board.provider,
      title: board.title,
      url: board.url,
      modelStatus: board.modelStatus,
      modelSyncError: board.modelSyncError,
    })),
  };
}

export async function previewModel(input: ModelInput) {
  const current = await getModel();
  return planModel(current, validateModel(input, current), await modelUsage(current));
}

export interface PropagationResult {
  workspaceId: string;
  workspaceName: string;
  status: 'applied' | 'skipped' | 'failed';
  message: string;
}

/**
 * Saves the model and applies it to every board that follows it. Cards of removed columns go to the column chosen
 * for each (`columnMoves`, model ids). Boards out of the model are skipped: they are synced from their workspace.
 */
export async function applyModel(input: ModelInput, columnMoves: Record<string, string>) {
  const current = await getModel();
  const desired = validateModel(input, current);
  const plan = planModel(current, desired, await modelUsage(current));
  const keptIds = new Set(desired.columns.filter((column) => current.columns.some((entry) => entry.id === column.id)).map((column) => column.id));
  for (const removed of plan.removedColumns) {
    if (!keptIds.has(columnMoves[removed.id] ?? '')) throw new HttpError(422, `Escolha para onde vão os cards da coluna "${removed.name}".`);
  }
  if (plan.changes.length === 0) return { model: current, results: [] as PropagationResult[] };
  await saveModel(desired);

  const boards = await prisma.taskBoard.findMany({ include: { workspace: { select: { name: true } } }, orderBy: { workspace: { name: 'asc' } } });
  const results: PropagationResult[] = [];
  for (const board of boards) {
    const base = { workspaceId: board.workspaceId, workspaceName: board.workspace.name };
    if (board.provider === 'STUDIO') {
      await applyModelToLocalTasks(board.workspaceId, desired, columnMoves);
      const statusMap = Object.fromEntries(desired.columns.filter((column) => column.role).map((column) => [column.role!, column.id]));
      await prisma.taskBoard.update({ where: { workspaceId: board.workspaceId }, data: { statusMap: statusMap as Prisma.InputJsonValue } });
      forgetSnapshot(board.workspaceId);
      results.push({ ...base, status: 'applied', message: 'Quadro do Studio atualizado.' });
      continue;
    }
    if (board.modelStatus !== 'synced' || !board.modelMap) {
      const reason = board.modelStatus === 'pending' ? 'ainda não foi convertido para o modelo' : 'está fora do modelo';
      results.push({ ...base, status: 'skipped', message: `O quadro ${reason}: sincronize na aba Quadro do workspace.` });
      continue;
    }
    try {
      const snapshot = await loadSnapshot(board, true);
      const provider = board.provider as Provider;
      const currentStructure = structureOf(snapshot.columns, snapshot.fields, provider);
      const mapping = mappingFromStored(board.modelMap as unknown as ModelMap, currentStructure);
      for (const [providerColumn, modelColumn] of Object.entries(mapping.columns)) {
        if (columnMoves[modelColumn]) mapping.columns[providerColumn] = columnMoves[modelColumn]!;
      }
      const applied = await runConversion(board, snapshot, desired, currentStructure, mapping);
      results.push({ ...base, status: 'applied', message: `${applied.changes.length} mudança(s) aplicada(s).` });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await prisma.taskBoard.update({ where: { workspaceId: board.workspaceId }, data: { modelStatus: 'drift', modelSyncError: message } });
      results.push({ ...base, status: 'failed', message });
    }
  }
  return { model: desired, results };
}

// ---------------------------------------------------------------- converting a board

/**
 * Moves the cards that must move, applies the provider structure equal to the model, then reads the board back
 * and records the map, the agent roles and whether it really follows the model now.
 */
async function runConversion(board: TaskBoard, snapshot: BoardSnapshot, model: BoardModel, current: BoardStructure, mapping: ConversionMapping) {
  const provider = board.provider as Provider;
  const plan = planSync(model, current, mapping, provider, snapshot.items);
  const desired = validateStructure(plan.desired, current, provider);
  const adapter = await adapterFor(board);
  const ref = refOf(board);

  for (const [from, to] of Object.entries(plan.columnMoves)) {
    for (const item of snapshot.items.filter((entry) => entry.columnId === from)) {
      await adapter.moveItem(ref, snapshot, item.id, to);
      item.columnId = to;
    }
  }
  for (const move of plan.optionMoves) {
    for (const item of snapshot.items.filter((entry) => entry.fields[move.fieldId] === move.from)) {
      await adapter.setItemField(ref, snapshot, item.id, move.fieldId, move.to);
      item.fields[move.fieldId] = move.to;
    }
  }
  await adapter.applyStructure(ref, current, desired);

  const ordered = await prisma.taskBoard.update({
    where: { workspaceId: board.workspaceId },
    data: { fieldOrder: provider === 'GITLAB' ? (fieldOrderOf(asStructure(model)) as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
  });
  forgetSnapshot(board.workspaceId);
  const fresh = await loadSnapshot(ordered, true);
  const applied = structureOf(fresh.columns, fresh.fields, provider);
  const map = mapByName(model, applied, provider);
  const synced = followsModel(model, applied, map, provider);
  await prisma.taskBoard.update({
    where: { workspaceId: board.workspaceId },
    data: {
      modelMap: map as unknown as Prisma.InputJsonValue,
      statusMap: statusMapFrom(model, map, provider) as Prisma.InputJsonValue,
      modelStatus: synced ? 'synced' : 'drift',
      modelSyncError: synced ? null : 'Depois de aplicar, o quadro ainda difere do modelo. Abra a sincronização para ver o que falta.',
    },
  });
  return plan;
}

function counts(snapshot: BoardSnapshot) {
  const columnItems: Record<string, number> = {};
  const optionItems: Record<string, Record<string, number>> = {};
  for (const item of snapshot.items) {
    if (item.columnId) columnItems[item.columnId] = (columnItems[item.columnId] ?? 0) + 1;
    for (const [fieldId, optionId] of Object.entries(item.fields)) {
      optionItems[fieldId] = { ...optionItems[fieldId], [optionId]: (optionItems[fieldId]?.[optionId] ?? 0) + 1 };
    }
  }
  return { columnItems, optionItems };
}

/** The board next to the model, with a suggested mapping (what it had, same names, roles guessed from names). */
export async function getConversion(workspaceId: string) {
  const board = await findBoard(workspaceId);
  if (board.provider === 'STUDIO') throw new HttpError(422, 'O quadro do Studio já segue o modelo.');
  const snapshot = await loadSnapshot(board, true);
  const provider = board.provider as Provider;
  const model = await getModel();
  const current = structureOf(snapshot.columns, snapshot.fields, provider);
  return {
    link: linkResponse(board),
    provider,
    model: {
      ...model,
      // On GitLab these are the fixed open/closed columns.
      columns: model.columns.map((column) => ({ ...column, fixed: fixedColumnOf(column, provider) !== null })),
    },
    current,
    suggestion: suggestMapping(model, current, provider, board.modelMap as unknown as ModelMap | null),
    ...counts(snapshot),
  };
}

async function conversionContext(workspaceId: string) {
  const board = await findBoard(workspaceId);
  if (board.provider === 'STUDIO') throw new HttpError(422, 'O quadro do Studio já segue o modelo.');
  const snapshot = await loadSnapshot(board, true);
  const provider = board.provider as Provider;
  return { board, snapshot, provider, model: await getModel(), current: structureOf(snapshot.columns, snapshot.fields, provider) };
}

export async function previewConversion(workspaceId: string, mapping: ConversionMapping) {
  const { snapshot, provider, model, current } = await conversionContext(workspaceId);
  const plan = planSync(model, current, mapping, provider, snapshot.items);
  validateStructure(plan.desired, current, provider);
  return { changes: plan.changes, lostValues: plan.lostValues, movedCards: plan.movedCards };
}

export async function applyConversion(workspaceId: string, mapping: ConversionMapping) {
  const { board, snapshot, model, current } = await conversionContext(workspaceId);
  try {
    const plan = await runConversion(board, snapshot, model, current, mapping);
    return { applied: plan.changes.length, link: linkResponse(await findBoard(workspaceId)) };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    if (board.modelStatus !== 'pending') {
      await prisma.taskBoard.update({ where: { workspaceId }, data: { modelStatus: 'drift', modelSyncError: message } });
    }
    throw error;
  }
}
