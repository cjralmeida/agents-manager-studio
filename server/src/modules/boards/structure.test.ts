import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BoardStructure, matchIdsByName, paletteColor, planStructure, templateStructure, validateStructure } from './structure.js';
import type { BoardItem } from './types.js';

const current: BoardStructure = {
  columns: [
    { id: 'c1', name: 'A fazer', color: 'GRAY', description: '' },
    { id: 'c2', name: 'Fazendo', color: 'YELLOW', description: '' },
    { id: 'c3', name: 'Feito', color: 'GREEN', description: '' },
  ],
  fields: [
    {
      id: 'f1',
      name: 'Prioridade',
      options: [
        { id: 'o1', name: 'Alta', color: 'RED', description: '' },
        { id: 'o2', name: 'Baixa', color: 'GREEN', description: '' },
      ],
    },
  ],
};

const item = (columnId: string, fields: Record<string, string> = {}) => ({ columnId, fields }) as unknown as BoardItem;

describe('planStructure', () => {
  it('lists nothing when the structure is the same', () => {
    assert.deepEqual(planStructure(current, current, []), { changes: [], removedColumns: [], lostValues: [] });
  });

  it('describes renames, new entries, order and removals with the cards they affect', () => {
    const desired: BoardStructure = {
      columns: [
        { id: 'c3', name: 'Concluído', color: 'GREEN', description: '' },
        { id: 'c1', name: 'A fazer', color: 'BLUE', description: '' },
        { id: null, name: 'Em validação', color: 'PURPLE', description: '' },
      ],
      fields: [{ id: 'f1', name: 'Prioridade', options: [{ id: 'o1', name: 'Alta', color: 'RED', description: '' }] }],
    };
    const plan = planStructure(current, desired, [item('c2'), item('c2', { f1: 'o2' }), item('c1', { f1: 'o1' })]);
    assert.deepEqual(plan.removedColumns, [{ id: 'c2', name: 'Fazendo', items: 2 }]);
    assert.deepEqual(plan.lostValues, [{ field: 'Prioridade', option: 'Baixa', items: 1 }]);
    for (const expected of [
      'Remover a coluna "Fazendo"',
      'Renomear a coluna "Feito" para "Concluído"',
      'Mudar a cor da coluna "A fazer"',
      'Criar a coluna "Em validação"',
      'Reordenar as colunas',
      'Remover a opção "Baixa" de "Prioridade"',
    ]) {
      assert.ok(plan.changes.includes(expected), `${expected} in ${JSON.stringify(plan.changes)}`);
    }
  });

  it('counts the cards that lose a removed field', () => {
    const plan = planStructure(current, { ...current, fields: [] }, [item('c1', { f1: 'o1' }), item('c1')]);
    assert.deepEqual(plan.lostValues, [{ field: 'Prioridade', option: null, items: 1 }]);
  });
});

describe('validateStructure', () => {
  it('trims names and accepts a valid structure', () => {
    const valid = validateStructure({ ...current, columns: [{ ...current.columns[0]!, name: '  A fazer  ' }] }, current, 'GITHUB');
    assert.equal(valid.columns[0]!.name, 'A fazer');
  });

  it('refuses duplicates, commas, reserved names and unknown ids', () => {
    const cases: BoardStructure[] = [
      { ...current, columns: [...current.columns, { id: null, name: 'feito', color: 'GRAY', description: '' }] },
      { ...current, columns: [{ id: null, name: 'A, B', color: 'GRAY', description: '' }] },
      { ...current, fields: [{ id: null, name: 'Status', options: [{ id: null, name: 'x', color: 'GRAY', description: '' }] }] },
      { ...current, fields: [{ id: null, name: 'Área: x', options: [{ id: null, name: 'x', color: 'GRAY', description: '' }] }] },
      { ...current, fields: [{ id: null, name: 'Vazio', options: [] }] },
      { ...current, columns: [{ id: 'gone', name: 'X', color: 'GRAY', description: '' }] },
      { ...current, columns: [] },
    ];
    for (const structure of cases) assert.throws(() => validateStructure(structure, current, 'GITHUB'), Error, JSON.stringify(structure.columns));
  });

  it('keeps GitLab fixed column names reserved', () => {
    assert.throws(() => validateStructure({ columns: [{ id: null, name: 'Concluído', color: 'GREEN', description: '' }], fields: [] }, { columns: [], fields: [] }, 'GITLAB'));
  });
});

describe('templateStructure', () => {
  it('leaves GitLab fixed columns out', () => {
    assert.equal(templateStructure('GITHUB').columns.length, 6);
    assert.deepEqual(
      templateStructure('GITLAB').columns.map((column) => column.name),
      ['Em andamento', 'Em validação', 'Em homologação', 'Aguardando aprovação'],
    );
  });
});

describe('matchIdsByName', () => {
  it('reuses the ids of same-named entries', () => {
    const desired = templateStructure('GITHUB');
    const created: BoardStructure = {
      columns: [{ id: 'x1', name: 'a fazer', color: 'GRAY', description: '' }],
      fields: [{ id: 'f9', name: 'Prioridade', options: [{ id: 'p0', name: 'P0 - Crítica', color: 'RED', description: '' }] }],
    };
    const matched = matchIdsByName(desired, created);
    assert.equal(matched.columns[0]!.id, 'x1');
    assert.equal(matched.columns[1]!.id, null);
    const priority = matched.fields.find((field) => field.name === 'Prioridade')!;
    assert.equal(priority.id, 'f9');
    assert.equal(priority.options[0]!.id, 'p0');
  });
});

describe('paletteColor', () => {
  it('maps any hex to the closest palette color', () => {
    assert.equal(paletteColor('#3fb950'), 'GREEN');
    assert.equal(paletteColor('#ff0000'), 'RED');
    assert.equal(paletteColor('#6699cc'), 'BLUE');
  });
});
