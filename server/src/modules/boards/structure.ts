import { HttpError } from '../../lib/errors.js';
import { BOARD_TEMPLATE, GITHUB_COLORS, type GitHubColor } from './template.js';
import type { BoardField, BoardItem, BoardOption } from './types.js';

/**
 * Board structure edited in the Studio: columns, fields and their options. The provider keeps the tasks; the
 * Studio reads its structure, the user edits it and the difference is applied. Ids come from the provider
 * (null = new), so renaming keeps the cards on their column/option.
 */

export interface StructureOption {
  id: string | null;
  name: string;
  /** GitHub's palette, used for both providers (GitLab labels get its hex). */
  color: GitHubColor;
  description: string;
}

export interface StructureField {
  id: string | null;
  name: string;
  options: StructureOption[];
}

export interface BoardStructure {
  /** Editable columns, in order. On GitLab "A fazer" (open) and "Concluído" (closed) are fixed and not listed. */
  columns: StructureOption[];
  fields: StructureField[];
}

/** GitLab's built-in columns: always first and last, not editable. */
export const GITLAB_FIXED_COLUMNS = { first: 'open', last: 'closed' } as const;

/** Names GitHub reserves for its own project fields. */
const RESERVED_FIELDS = ['status', 'title', 'assignees', 'labels', 'linked pull requests', 'milestone', 'repository', 'reviewers', 'parent issue', 'sub-issues progress', 'type'];
const MAX_OPTIONS = 50;
const MAX_FIELDS = 20;

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((char) => char + char).join('') : value;
  const number = Number.parseInt(full.slice(0, 6), 16);
  return Number.isNaN(number) ? [128, 128, 128] : [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/** Palette color closest to a hex (GitLab labels may use any color). */
export function paletteColor(hex: string): GitHubColor {
  const [r = 0, g = 0, b = 0] = hexToRgb(hex);
  let best: GitHubColor = 'GRAY';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, value] of Object.entries(GITHUB_COLORS) as [GitHubColor, string][]) {
    const [r2, g2, b2] = hexToRgb(value);
    const distance = (r - r2!) ** 2 + (g - g2!) ** 2 + (b - b2!) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

const toStructureOption = (option: BoardOption): StructureOption => ({
  id: option.id,
  name: option.name,
  color: paletteColor(option.color),
  description: option.description ?? '',
});

/** Structure of a loaded board (GitLab's fixed columns are left out). */
export function structureOf(columns: BoardOption[], fields: BoardField[], provider: 'GITHUB' | 'GITLAB'): BoardStructure {
  const fixed: string[] = provider === 'GITLAB' ? [GITLAB_FIXED_COLUMNS.first, GITLAB_FIXED_COLUMNS.last] : [];
  return {
    columns: columns.filter((column) => !fixed.includes(column.id)).map(toStructureOption),
    fields: fields.map((field) => ({ id: field.id, name: field.name, options: field.options.map(toStructureOption) })),
  };
}

/** The Studio template as a structure to start from (all new). */
export function templateStructure(provider: 'GITHUB' | 'GITLAB'): BoardStructure {
  const statuses = provider === 'GITLAB' ? BOARD_TEMPLATE.statuses.filter((status) => status.role !== 'todo' && status.role !== 'done') : BOARD_TEMPLATE.statuses;
  const option = ({ name, color, description }: { name: string; color: GitHubColor; description: string }) => ({ id: null, name, color, description });
  return {
    columns: statuses.map(option),
    fields: BOARD_TEMPLATE.fields.map((field) => ({ id: null, name: field.name, options: field.options.map(option) })),
  };
}

const key = (name: string) => name.trim().toLowerCase();

/** Trims names and refuses what the providers would reject or what would break GitLab label lists. */
export function validateStructure(structure: BoardStructure, current: BoardStructure, provider: 'GITHUB' | 'GITLAB'): BoardStructure {
  const problem = (message: string) => new HttpError(422, message);
  const checkName = (name: string, what: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw problem(`Dê um nome a ${what}.`);
    if (trimmed.length > 80) throw problem(`"${trimmed.slice(0, 30)}…" é longo demais (máximo 80 caracteres).`);
    if (trimmed.includes(',')) throw problem(`"${trimmed}" não pode ter vírgula.`);
    return trimmed;
  };
  const unique = (names: string[], what: string) => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(key(name))) throw problem(`${what} "${name}" aparece duas vezes.`);
      seen.add(key(name));
    }
  };
  const knownColumns = new Set(current.columns.map((column) => column.id));
  const knownFields = new Map(current.fields.map((field) => [field.id, new Set(field.options.map((option) => option.id))]));

  if (provider === 'GITHUB' && structure.columns.length === 0) throw problem('O quadro precisa de pelo menos uma coluna.');
  if (structure.columns.length > MAX_OPTIONS) throw problem(`Use no máximo ${MAX_OPTIONS} colunas.`);
  if (structure.fields.length > MAX_FIELDS) throw problem(`Use no máximo ${MAX_FIELDS} campos.`);

  const columns = structure.columns.map((column) => {
    if (column.id !== null && !knownColumns.has(column.id)) throw problem('Uma das colunas não existe mais no quadro. Recarregue a estrutura.');
    return { ...column, name: checkName(column.name, 'todas as colunas'), description: column.description.trim() };
  });
  // GitLab's fixed columns keep their names; an editable one with the same name would be confusing.
  const names = provider === 'GITLAB' ? ['A fazer', 'Concluído', ...columns.map((column) => column.name)] : columns.map((column) => column.name);
  unique(names, 'A coluna');

  const fields = structure.fields.map((field) => {
    if (field.id !== null && !knownFields.has(field.id)) throw problem('Um dos campos não existe mais no quadro. Recarregue a estrutura.');
    const name = checkName(field.name, 'todos os campos');
    if (name.includes(':')) throw problem(`O campo "${name}" não pode ter dois-pontos.`);
    if (RESERVED_FIELDS.includes(key(name))) throw problem(`"${name}" é um nome reservado; escolha outro para o campo.`);
    if (field.options.length === 0) throw problem(`O campo "${name}" precisa de pelo menos uma opção.`);
    if (field.options.length > MAX_OPTIONS) throw problem(`Use no máximo ${MAX_OPTIONS} opções em "${name}".`);
    const knownOptions = field.id === null ? new Set<string | null>() : knownFields.get(field.id)!;
    const options = field.options.map((option) => {
      if (option.id !== null && !knownOptions.has(option.id)) throw problem(`Uma opção de "${name}" não existe mais no quadro. Recarregue a estrutura.`);
      return { ...option, name: checkName(option.name, `todas as opções de "${name}"`), description: option.description.trim() };
    });
    unique(
      options.map((option) => option.name),
      `A opção de "${name}"`,
    );
    return { ...field, name, options };
  });
  unique(
    fields.map((field) => field.name),
    'O campo',
  );
  return { columns, fields };
}

export interface StructurePlan {
  changes: string[];
  /** Columns that go away while holding cards: the cards must move first. */
  removedColumns: { id: string; name: string; items: number }[];
  /** Field values the cards lose (removed option or field). */
  lostValues: { field: string; option: string | null; items: number }[];
}

function describeOption(before: StructureOption, after: StructureOption, noun: 'coluna' | 'opção') {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`renomear a ${noun} "${before.name}" para "${after.name}"`);
  if (before.color !== after.color) parts.push(`mudar a cor da ${noun} "${after.name}"`);
  if (before.description !== after.description) parts.push(`mudar a descrição da ${noun} "${after.name}"`);
  return parts;
}

const sameOrder = (a: (string | null)[], b: (string | null)[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** What applying `desired` over `current` changes, with the cards affected by removals. */
export function planStructure(current: BoardStructure, desired: BoardStructure, items: BoardItem[]): StructurePlan {
  const changes: string[] = [];
  const removedColumns: StructurePlan['removedColumns'] = [];
  const lostValues: StructurePlan['lostValues'] = [];
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  // Columns.
  const desiredColumns = new Map(desired.columns.filter((column) => column.id).map((column) => [column.id, column]));
  for (const column of current.columns) {
    const next = desiredColumns.get(column.id);
    if (!next) {
      changes.push(`Remover a coluna "${column.name}"`);
      const count = items.filter((item) => item.columnId === column.id).length;
      if (count > 0) removedColumns.push({ id: column.id!, name: column.name, items: count });
    } else {
      changes.push(...describeOption(column, next, 'coluna').map(capital));
    }
  }
  for (const column of desired.columns.filter((entry) => entry.id === null)) changes.push(`Criar a coluna "${column.name}"`);
  const keptCurrent = current.columns.filter((column) => desiredColumns.has(column.id)).map((column) => column.id);
  const keptDesired = desired.columns.filter((column) => column.id !== null).map((column) => column.id);
  if (!sameOrder(keptCurrent, keptDesired)) changes.push('Reordenar as colunas');

  // Fields.
  const desiredFields = new Map(desired.fields.filter((field) => field.id).map((field) => [field.id, field]));
  for (const field of current.fields) {
    const next = desiredFields.get(field.id);
    const withValue = (optionId: string | null) => items.filter((item) => optionId !== null && item.fields[field.id!] === optionId).length;
    if (!next) {
      changes.push(`Remover o campo "${field.name}"`);
      const count = items.filter((item) => item.fields[field.id!] !== undefined).length;
      if (count > 0) lostValues.push({ field: field.name, option: null, items: count });
      continue;
    }
    if (field.name !== next.name) changes.push(`Renomear o campo "${field.name}" para "${next.name}"`);
    const nextOptions = new Map(next.options.filter((option) => option.id).map((option) => [option.id, option]));
    for (const option of field.options) {
      const updated = nextOptions.get(option.id);
      if (!updated) {
        changes.push(`Remover a opção "${option.name}" de "${next.name}"`);
        const count = withValue(option.id);
        if (count > 0) lostValues.push({ field: next.name, option: option.name, items: count });
      } else {
        changes.push(...describeOption(option, updated, 'opção').map((text) => `${capital(text)} em "${next.name}"`));
      }
    }
    for (const option of next.options.filter((entry) => entry.id === null)) changes.push(`Criar a opção "${option.name}" em "${next.name}"`);
    const kept = field.options.filter((option) => nextOptions.has(option.id)).map((option) => option.id);
    if (!sameOrder(kept, next.options.filter((option) => option.id !== null).map((option) => option.id))) {
      changes.push(`Reordenar as opções de "${next.name}"`);
    }
  }
  for (const field of desired.fields.filter((entry) => entry.id === null)) {
    changes.push(`Criar o campo "${field.name}" com ${field.options.map((option) => `"${option.name}"`).join(', ')}`);
  }
  const keptFields = current.fields.filter((field) => desiredFields.has(field.id)).map((field) => field.id);
  if (!sameOrder(keptFields, desired.fields.filter((field) => field.id !== null).map((field) => field.id))) changes.push('Reordenar os campos');

  return { changes, removedColumns, lostValues };
}

/** Gives desired entries the ids of same-named entries of a board just created (e.g. copied from a template). */
export function matchIdsByName(desired: BoardStructure, created: BoardStructure): BoardStructure {
  const byName = <T extends { id: string | null; name: string }>(list: T[]) => new Map(list.map((entry) => [key(entry.name), entry]));
  const columns = byName(created.columns);
  const fields = byName(created.fields);
  return {
    columns: desired.columns.map((column) => ({ ...column, id: columns.get(key(column.name))?.id ?? null })),
    fields: desired.fields.map((field) => {
      const match = fields.get(key(field.name));
      const options = byName(match?.options ?? []);
      return {
        ...field,
        id: match?.id ?? null,
        options: field.options.map((option) => ({ ...option, id: options.get(key(option.name))?.id ?? null })),
      };
    }),
  };
}

export interface FieldOrder {
  fields: string[];
  options: Record<string, string[]>;
}

export function fieldOrderOf(structure: BoardStructure): FieldOrder {
  return {
    fields: structure.fields.map((field) => field.name),
    options: Object.fromEntries(structure.fields.map((field) => [field.name, field.options.map((option) => option.name)])),
  };
}
