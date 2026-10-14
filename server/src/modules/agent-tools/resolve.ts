import type { BoardField, BoardOption } from '../boards/types.js';

/** Case- and accent-insensitive key, so agents can write "em validacao" for "Em validação". */
export function nameKey(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function findByName<T extends { name: string }>(items: T[], name: string): T | undefined {
  const key = nameKey(name);
  return items.find((item) => nameKey(item.name) === key) ?? items.find((item) => nameKey(item.name).startsWith(key));
}

/**
 * Turns `{ "Tipo": "Bug", "Prioridade": "P1" }` into board field/option ids. Unknown names are reported
 * back to the agent instead of being silently dropped.
 */
/** Field values by names; an empty value clears the field. */
export function resolveFields(fields: BoardField[], values: Record<string, string>) {
  const resolved: Record<string, string | null> = {};
  const errors: string[] = [];
  for (const [fieldName, optionName] of Object.entries(values)) {
    const field = findByName(fields, fieldName);
    if (!field) {
      errors.push(`Campo "${fieldName}" não existe. Campos: ${fields.map((entry) => entry.name).join(', ')}.`);
      continue;
    }
    if (!optionName?.trim()) {
      resolved[field.id] = null;
      continue;
    }
    const option = findByName(field.options, optionName);
    if (!option) {
      errors.push(`"${optionName}" não é opção de ${field.name}. Opções: ${field.options.map((entry) => entry.name).join(', ')}.`);
      continue;
    }
    resolved[field.id] = option.id;
  }
  return { resolved, errors };
}

export function resolveColumn(columns: BoardOption[], name: string) {
  const column = findByName(columns, name);
  if (!column) throw new Error(`Coluna "${name}" não existe. Colunas: ${columns.map((entry) => entry.name).join(', ')}.`);
  return column;
}
