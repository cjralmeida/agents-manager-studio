import type { BoardModel } from './model.js';
import { type ModelMap, fixedColumnOf } from './model-sync.js';
import { GITHUB_COLORS } from './template.js';
import type { BoardField, BoardItem, BoardOption, StatusMap } from './types.js';

/**
 * A workspace board joins several sources (GitHub Project, GitLab group board, Studio tasks). Every source follows
 * the board model, so the joined board speaks the model: its columns and fields are the model's, and each source's
 * own ids are translated through the map recorded when the source was converted to the model.
 */

export type SourceProvider = 'GITHUB' | 'GITLAB' | 'STUDIO';

export interface SourceMapping {
  provider: SourceProvider;
  /** Provider ids -> model ids; Studio sources use the model ids directly. */
  modelMap: ModelMap | null;
}

/** A joined task id: "<source id>:<id in the source>" (source ids are uuids, so the first ":" splits them). */
export function joinedItemId(sourceId: string, itemId: string) {
  return `${sourceId}:${itemId}`;
}

export function splitItemId(id: string) {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  return { sourceId: id.slice(0, at), itemId: id.slice(at + 1) };
}

/** Source column -> model column. */
export function toModelColumn(source: SourceMapping, model: BoardModel, columnId: string | null) {
  if (!columnId) return null;
  if (source.provider === 'STUDIO') return columnId;
  const fixed = model.columns.find((column) => fixedColumnOf(column, source.provider as 'GITHUB' | 'GITLAB') === columnId);
  if (fixed) return fixed.id;
  return source.modelMap?.columns[columnId] ?? null;
}

/** Model column -> source column, or null when the source does not have it. */
export function toSourceColumn(source: SourceMapping, model: BoardModel, modelColumnId: string) {
  const column = model.columns.find((entry) => entry.id === modelColumnId);
  if (!column) return null;
  if (source.provider === 'STUDIO') return column.id;
  const fixed = fixedColumnOf(column, source.provider);
  if (fixed) return fixed;
  return Object.entries(source.modelMap?.columns ?? {}).find(([, modelId]) => modelId === column.id)?.[0] ?? null;
}

/** Source field values -> model field values (values the model does not know are dropped). */
export function toModelFields(source: SourceMapping, fields: Record<string, string>) {
  if (source.provider === 'STUDIO') return fields;
  const result: Record<string, string> = {};
  for (const [fieldId, optionId] of Object.entries(fields)) {
    const field = source.modelMap?.fields[fieldId];
    const option = field?.options[optionId];
    if (field && option) result[field.model] = option;
  }
  return result;
}

/** Model field (and option, or null to clear) -> the source's ids; null when the source does not have them. */
export function toSourceField(source: SourceMapping, modelFieldId: string, modelOptionId: string | null) {
  if (source.provider === 'STUDIO') return { fieldId: modelFieldId, optionId: modelOptionId };
  const entry = Object.entries(source.modelMap?.fields ?? {}).find(([, field]) => field.model === modelFieldId);
  if (!entry) return null;
  const [fieldId, field] = entry;
  if (modelOptionId === null) return { fieldId, optionId: null };
  const optionId = Object.entries(field.options).find(([, modelId]) => modelId === modelOptionId)?.[0];
  return optionId ? { fieldId, optionId } : null;
}

/** All model field values of a new task, in the source's ids (values the source lacks are left out). */
export function toSourceFields(source: SourceMapping, fields: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const [fieldId, optionId] of Object.entries(fields)) {
    const translated = toSourceField(source, fieldId, optionId);
    if (translated?.optionId) result[translated.fieldId] = translated.optionId;
  }
  return result;
}

/** A source item on the joined board: joined id, model column and fields. */
export function toJoinedItem(sourceId: string, source: SourceMapping, model: BoardModel, item: BoardItem): BoardItem & { sourceId: string } {
  return {
    ...item,
    id: joinedItemId(sourceId, item.id),
    columnId: toModelColumn(source, model, item.columnId),
    fields: toModelFields(source, item.fields),
    sourceId,
  };
}

/** The model as board columns and fields (hex colors), and the column of each agent role. */
export function modelLayout(model: BoardModel): { columns: BoardOption[]; fields: BoardField[]; statusMap: StatusMap } {
  return {
    columns: model.columns.map((column) => ({ id: column.id, name: column.name, color: GITHUB_COLORS[column.color], description: column.description || null })),
    fields: model.fields.map((field) => ({
      id: field.id,
      name: field.name,
      options: field.options.map((option) => ({ id: option.id, name: option.name, color: GITHUB_COLORS[option.color], description: option.description || null })),
    })),
    statusMap: Object.fromEntries(model.columns.filter((column) => column.role).map((column) => [column.role!, column.id])),
  };
}
