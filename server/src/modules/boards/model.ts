import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/errors.js';
import { type BoardStructure, type StructureOption, planStructure, validateStructure } from './structure.js';
import { BOARD_TEMPLATE } from './template.js';
import { STATUS_ROLES, type StatusRole } from './types.js';

/**
 * The Studio board model: one structure (columns with agent roles, fields and options) followed by every
 * workspace board. Ids are the Studio's own and never change, so each provider board keeps a map from its ids
 * to these.
 */

export interface ModelColumn extends StructureOption {
  id: string;
  /** Agent role of the column; "todo" and "done" are required (on GitLab they are the open/closed issues). */
  role: StatusRole | null;
}

export interface ModelOption extends StructureOption {
  id: string;
}

export interface ModelField {
  id: string;
  name: string;
  options: ModelOption[];
}

export interface BoardModel {
  columns: ModelColumn[];
  fields: ModelField[];
}

/** What the editor sends: new entries have no id yet. */
export interface ModelInput {
  columns: (Omit<ModelColumn, 'id'> & { id: string | null })[];
  fields: { id: string | null; name: string; options: (Omit<ModelOption, 'id'> & { id: string | null })[] }[];
}

export const REQUIRED_ROLES: StatusRole[] = ['todo', 'done'];

export const roleLabels: Record<StatusRole, string> = {
  todo: 'A fazer',
  inProgress: 'Em andamento',
  review: 'Em validação',
  homologation: 'Em homologação',
  done: 'Concluído',
  blocked: 'Bloqueado para agentes',
};

/** The Studio template as the first model. */
export function defaultModel(): BoardModel {
  return {
    columns: BOARD_TEMPLATE.statuses.map(({ role, name, color, description }) => ({ id: randomUUID(), role, name, color, description })),
    fields: BOARD_TEMPLATE.fields.map((field) => ({
      id: randomUUID(),
      name: field.name,
      options: field.options.map(({ name, color, description }) => ({ id: randomUUID(), name, color, description })),
    })),
  };
}

export const asStructure = (model: BoardModel | ModelInput): BoardStructure => ({
  columns: model.columns.map(({ id, name, color, description }) => ({ id, name, color, description })),
  fields: model.fields.map((field) => ({
    id: field.id,
    name: field.name,
    options: field.options.map(({ id, name, color, description }) => ({ id, name, color, description })),
  })),
});

/** Same name and option rules as a board, plus the roles; new entries get their ids here. */
export function validateModel(input: ModelInput, current: BoardModel): BoardModel {
  const valid = validateStructure(asStructure(input), asStructure(current), 'GITHUB');
  const seen = new Set<StatusRole>();
  for (const column of input.columns) {
    if (!column.role) continue;
    if (!STATUS_ROLES.includes(column.role)) throw new HttpError(422, 'Papel de coluna desconhecido.');
    if (seen.has(column.role)) throw new HttpError(422, `O papel "${roleLabels[column.role]}" está em mais de uma coluna.`);
    seen.add(column.role);
  }
  for (const role of REQUIRED_ROLES) {
    if (!seen.has(role)) throw new HttpError(422, `Marque uma coluna com o papel "${roleLabels[role]}".`);
  }
  return {
    columns: valid.columns.map((column, index) => ({ ...column, id: column.id ?? randomUUID(), role: input.columns[index]!.role ?? null })),
    fields: valid.fields.map((field) => ({
      id: field.id ?? randomUUID(),
      name: field.name,
      options: field.options.map((option) => ({ ...option, id: option.id ?? randomUUID() })),
    })),
  };
}

/** How many cards (over all boards that follow the model) use each model column and option. */
export interface ModelUsage {
  columns: Record<string, number>;
  options: Record<string, Record<string, number>>;
  fields: Record<string, number>;
}

export interface ModelPlan {
  changes: string[];
  /** Removed columns: their cards (in every board) need a destination column of the model. */
  removedColumns: { id: string; name: string; items: number }[];
  lostValues: { field: string; option: string | null; items: number }[];
}

/** Changes between two versions of the model; ids of `desired` must already be resolved. */
export function planModel(current: BoardModel, desired: BoardModel, usage: ModelUsage): ModelPlan {
  // Entries the current model does not have are new, even though validation already gave them ids.
  const known = new Set([...current.columns.map((column) => column.id), ...current.fields.flatMap((field) => [field.id, ...field.options.map((option) => option.id)])]);
  const asNew = <T extends { id: string | null }>(entry: T) => ({ ...entry, id: entry.id && known.has(entry.id) ? entry.id : null });
  const desiredStructure = asStructure({
    columns: desired.columns.map(asNew),
    fields: desired.fields.map((field) => ({ ...asNew(field), options: field.options.map(asNew) })),
  });
  const { changes } = planStructure(asStructure(current), desiredStructure, []);
  const kept = new Set(desired.columns.map((column) => column.id));
  const removedColumns = current.columns
    .filter((column) => !kept.has(column.id))
    .map((column) => ({ id: column.id, name: column.name, items: usage.columns[column.id] ?? 0 }));

  for (const column of desired.columns) {
    const before = current.columns.find((entry) => entry.id === column.id);
    if (before && before.role !== column.role) {
      changes.push(`Papel da coluna "${column.name}": ${column.role ? roleLabels[column.role] : 'nenhum'}`);
    } else if (!before && column.role) {
      changes.push(`Papel da coluna "${column.name}": ${roleLabels[column.role]}`);
    }
  }

  const lostValues: ModelPlan['lostValues'] = [];
  for (const field of current.fields) {
    const next = desired.fields.find((entry) => entry.id === field.id);
    if (!next) {
      if (usage.fields[field.id]) lostValues.push({ field: field.name, option: null, items: usage.fields[field.id]! });
      continue;
    }
    for (const option of field.options) {
      const count = usage.options[field.id]?.[option.id] ?? 0;
      if (count > 0 && !next.options.some((entry) => entry.id === option.id)) lostValues.push({ field: next.name, option: option.name, items: count });
    }
  }
  return { changes, removedColumns, lostValues };
}
