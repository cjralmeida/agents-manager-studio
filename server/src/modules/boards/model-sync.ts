import { HttpError } from '../../lib/errors.js';
import type { BoardModel, ModelColumn } from './model.js';
import { roleFromName } from './roles.js';
import { type BoardStructure, GITLAB_FIXED_COLUMNS, type StructureField, type StructureOption, planStructure } from './structure.js';
import type { BoardItem, StatusMap } from './types.js';

/**
 * A provider board following the Studio model. The board keeps a map from its own ids to the model ids; with it
 * the Studio works out what to rename, create, remove, and which cards to move first.
 */

type Provider = 'GITHUB' | 'GITLAB';

export interface ModelMap {
  /** Provider column id -> model column id. */
  columns: Record<string, string>;
  /** Provider field id -> model field id and its options (provider option id -> model option id). */
  fields: Record<string, { model: string; options: Record<string, string> }>;
}

/**
 * The user's choices when converting: every provider column goes to a model column; fields and options map to
 * the model or to null (removed, the cards lose that value).
 */
export interface ConversionMapping {
  columns: Record<string, string>;
  fields: Record<string, string | null>;
  options: Record<string, Record<string, string | null>>;
}

/** On GitLab the model's "todo" and "done" columns are the fixed open/closed columns, not labels. */
export function fixedColumnOf(column: ModelColumn, provider: Provider) {
  if (provider !== 'GITLAB') return null;
  if (column.role === 'todo') return GITLAB_FIXED_COLUMNS.first;
  if (column.role === 'done') return GITLAB_FIXED_COLUMNS.last;
  return null;
}

/** Model columns that are real columns on the provider. */
export function providerColumns(model: BoardModel, provider: Provider) {
  return model.columns.filter((column) => fixedColumnOf(column, provider) === null);
}

const normalize = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/**
 * Suggested mapping: what the board already had, else same name, else (columns) the role guessed from the name.
 * Columns left without a suggestion must be chosen by the user.
 */
export function suggestMapping(model: BoardModel, current: BoardStructure, provider: Provider, stored: ModelMap | null): ConversionMapping {
  const modelColumnIds = new Set(model.columns.map((column) => column.id));
  const byName = <T extends { id: string; name: string }>(list: T[], name: string) => list.find((entry) => normalize(entry.name) === normalize(name));

  const columns: ConversionMapping['columns'] = {};
  for (const column of current.columns) {
    const id = column.id!;
    const remembered = stored?.columns[id];
    const role = roleFromName(column.name);
    const match =
      (remembered && modelColumnIds.has(remembered) ? remembered : undefined) ??
      byName(model.columns, column.name)?.id ??
      (role ? model.columns.find((entry) => entry.role === role)?.id : undefined);
    if (match) columns[id] = match;
  }

  const fields: ConversionMapping['fields'] = {};
  const options: ConversionMapping['options'] = {};
  for (const field of current.fields) {
    const id = field.id!;
    const remembered = stored?.fields[id];
    const target = model.fields.find((entry) => entry.id === remembered?.model) ?? byName(model.fields, field.name) ?? null;
    fields[id] = target?.id ?? null;
    options[id] = {};
    for (const option of field.options) {
      const rememberedOption = remembered?.options[option.id!];
      const match = target?.options.find((entry) => entry.id === rememberedOption) ?? (target ? byName(target.options, option.name) : undefined);
      options[id]![option.id!] = match?.id ?? null;
    }
  }
  return { columns, fields, options };
}

/** The mapping a board already has, as conversion choices (used to re-apply the model to a synced board). */
export function mappingFromStored(stored: ModelMap, current: BoardStructure): ConversionMapping {
  const fields: ConversionMapping['fields'] = {};
  const options: ConversionMapping['options'] = {};
  for (const field of current.fields) {
    const entry = stored.fields[field.id!];
    fields[field.id!] = entry?.model ?? null;
    options[field.id!] = Object.fromEntries(field.options.map((option) => [option.id!, entry?.options[option.id!] ?? null]));
  }
  const columns = Object.fromEntries(current.columns.filter((column) => stored.columns[column.id!]).map((column) => [column.id!, stored.columns[column.id!]!]));
  return { columns, fields, options };
}

export interface SyncPlan {
  /** Provider structure to apply (kept provider ids, model names/colors/order). */
  desired: BoardStructure;
  /** Cards to move before applying: provider column -> provider column (GitLab may target open/closed). */
  columnMoves: Record<string, string>;
  /** Field values to reassign before applying (options merged into one). */
  optionMoves: { fieldId: string; from: string; to: string }[];
  changes: string[];
  /** Cards that lose a field value (field or option removed). */
  lostValues: { field: string; option: string | null; items: number }[];
  /** Cards moved because their column merges into another. */
  movedCards: number;
}

/**
 * From a mapping, the provider structure equal to the model. When several provider entries map to the same model
 * entry, the one with most cards is kept (renamed) and the others' cards move to it.
 */
export function planSync(model: BoardModel, current: BoardStructure, mapping: ConversionMapping, provider: Provider, items: BoardItem[]): SyncPlan {
  const modelColumns = new Map(model.columns.map((column) => [column.id, column]));
  const unmapped = current.columns.filter((column) => !modelColumns.has(mapping.columns[column.id!] ?? ''));
  if (unmapped.length > 0) {
    throw new HttpError(422, `Escolha a coluna do modelo para: ${unmapped.map((column) => `"${column.name}"`).join(', ')}.`);
  }
  const cardsIn = (columnId: string) => items.filter((item) => item.columnId === columnId).length;
  const byCards = (a: StructureOption, b: StructureOption) => cardsIn(b.id!) - cardsIn(a.id!);

  const columnMoves: Record<string, string> = {};
  const kept = new Map<string, StructureOption>();
  for (const column of model.columns) {
    const group = current.columns.filter((entry) => mapping.columns[entry.id!] === column.id).sort(byCards);
    const fixed = fixedColumnOf(column, provider);
    if (fixed) {
      for (const entry of group) columnMoves[entry.id!] = fixed;
      continue;
    }
    const [keep, ...rest] = group;
    if (keep) {
      kept.set(column.id, keep);
      for (const entry of rest) columnMoves[entry.id!] = keep.id!;
    }
  }
  const desiredColumns: StructureOption[] = providerColumns(model, provider).map((column) => ({
    id: kept.get(column.id)?.id ?? null,
    name: column.name,
    color: column.color,
    description: column.description,
  }));

  const optionMoves: SyncPlan['optionMoves'] = [];
  const lostValues: SyncPlan['lostValues'] = [];
  const valueCount = (fieldId: string, optionId: string) => items.filter((item) => item.fields[fieldId] === optionId).length;
  const desiredFields: StructureField[] = model.fields.map((field) => {
    const sources = current.fields.filter((entry) => mapping.fields[entry.id!] === field.id);
    const [source, ...duplicates] = sources;
    for (const duplicate of duplicates) {
      const count = items.filter((item) => item.fields[duplicate.id!] !== undefined).length;
      if (count > 0) lostValues.push({ field: duplicate.name, option: null, items: count });
    }
    const options = field.options.map((option) => {
      const group = (source?.options ?? [])
        .filter((entry) => mapping.options[source!.id!]?.[entry.id!] === option.id)
        .sort((a, b) => valueCount(source!.id!, b.id!) - valueCount(source!.id!, a.id!));
      const [keep, ...rest] = group;
      for (const entry of rest) optionMoves.push({ fieldId: source!.id!, from: entry.id!, to: keep!.id! });
      return { id: keep?.id ?? null, name: option.name, color: option.color, description: option.description };
    });
    const modelOptionIds = new Set(field.options.map((option) => option.id));
    for (const option of source?.options ?? []) {
      const count = valueCount(source!.id!, option.id!);
      if (count > 0 && !modelOptionIds.has(mapping.options[source!.id!]?.[option.id!] ?? '')) {
        lostValues.push({ field: source!.name, option: option.name, items: count });
      }
    }
    return { id: source?.id ?? null, name: field.name, options };
  });
  const modelFieldIds = new Set(model.fields.map((field) => field.id));
  for (const field of current.fields) {
    if (modelFieldIds.has(mapping.fields[field.id!] ?? '')) continue;
    const count = items.filter((item) => item.fields[field.id!] !== undefined).length;
    if (count > 0) lostValues.push({ field: field.name, option: null, items: count });
  }

  const desired = { columns: desiredColumns, fields: desiredFields };
  const { changes } = planStructure(current, desired, []);
  const movedCards = Object.keys(columnMoves).reduce((total, id) => total + cardsIn(id), 0);
  if (movedCards > 0) changes.unshift(`Mover ${movedCards} card(s) de colunas que se juntam a outras`);
  const mergedValues = optionMoves.reduce((total, move) => total + valueCount(move.fieldId, move.from), 0);
  if (mergedValues > 0) changes.unshift(`Trocar o valor de ${mergedValues} card(s) em opções que se juntam`);
  return { desired, columnMoves, optionMoves, changes, lostValues, movedCards };
}

/** After applying, provider and model have the same names: the map is rebuilt from them. */
export function mapByName(model: BoardModel, applied: BoardStructure, provider: Provider): ModelMap {
  const columns: ModelMap['columns'] = {};
  for (const column of providerColumns(model, provider)) {
    const match = applied.columns.find((entry) => normalize(entry.name) === normalize(column.name));
    if (match) columns[match.id!] = column.id;
  }
  const fields: ModelMap['fields'] = {};
  for (const field of model.fields) {
    const match = applied.fields.find((entry) => normalize(entry.name) === normalize(field.name));
    if (!match) continue;
    const options: Record<string, string> = {};
    for (const option of field.options) {
      const found = match.options.find((entry) => normalize(entry.name) === normalize(option.name));
      if (found) options[found.id!] = option.id;
    }
    fields[match.id!] = { model: field.id, options };
  }
  return { columns, fields };
}

/** Agent roles of the board, from the model roles and the map. */
export function statusMapFrom(model: BoardModel, map: ModelMap, provider: Provider): StatusMap {
  const statusMap: StatusMap = {};
  for (const column of model.columns) {
    if (!column.role) continue;
    const fixed = fixedColumnOf(column, provider);
    const providerId = fixed ?? Object.entries(map.columns).find(([, modelId]) => modelId === column.id)?.[0];
    if (providerId) statusMap[column.role] = providerId;
  }
  return statusMap;
}

/** True when the provider board is exactly the model (nothing to apply, everything mapped). */
export function followsModel(model: BoardModel, current: BoardStructure, map: ModelMap | null, provider: Provider) {
  if (!map) return false;
  try {
    const plan = planSync(model, current, mappingFromStored(map, current), provider, []);
    const allFieldsMapped = current.fields.every((field) => map.fields[field.id!] && field.options.every((option) => map.fields[field.id!]!.options[option.id!]));
    return plan.changes.length === 0 && Object.keys(plan.columnMoves).length === 0 && allFieldsMapped;
  } catch {
    return false;
  }
}

/** The model as a new provider board (all ids null), used to create boards. */
export function modelAsProviderStructure(model: BoardModel, provider: Provider): BoardStructure {
  return {
    columns: providerColumns(model, provider).map(({ name, color, description }) => ({ id: null, name, color, description })),
    fields: model.fields.map((field) => ({
      id: null,
      name: field.name,
      options: field.options.map(({ name, color, description }) => ({ id: null, name, color, description })),
    })),
  };
}
