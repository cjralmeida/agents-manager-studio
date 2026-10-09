import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BoardModel, planModel, validateModel } from './model.js';
import { followsModel, mapByName, modelAsProviderStructure, planSync, statusMapFrom, suggestMapping } from './model-sync.js';
import type { BoardStructure } from './structure.js';
import type { BoardItem } from './types.js';

const model: BoardModel = {
  columns: [
    { id: 'm-todo', role: 'todo', name: 'A fazer', color: 'GRAY', description: '' },
    { id: 'm-doing', role: 'inProgress', name: 'Em andamento', color: 'YELLOW', description: '' },
    { id: 'm-done', role: 'done', name: 'Concluído', color: 'GREEN', description: '' },
  ],
  fields: [
    {
      id: 'm-prio',
      name: 'Prioridade',
      options: [
        { id: 'm-high', name: 'Alta', color: 'RED', description: '' },
        { id: 'm-low', name: 'Baixa', color: 'GREEN', description: '' },
      ],
    },
  ],
};

const item = (columnId: string, fields: Record<string, string> = {}) => ({ id: `i-${Math.random()}`, columnId, fields }) as unknown as BoardItem;

describe('validateModel', () => {
  it('requires the todo and done roles once each and gives ids to new entries', () => {
    const valid = validateModel({ ...model, columns: [...model.columns, { id: null, role: null, name: 'Nova', color: 'BLUE', description: '' }] }, model);
    assert.equal(valid.columns.length, 4);
    assert.ok(valid.columns[3]!.id);
    assert.throws(() => validateModel({ ...model, columns: model.columns.map((column) => ({ ...column, role: column.role === 'done' ? null : column.role })) }, model));
    assert.throws(() => validateModel({ ...model, columns: model.columns.map((column) => ({ ...column, role: 'todo' as const })) }, model));
  });
});

describe('planModel', () => {
  it('lists role changes and the removed columns with their cards', () => {
    const desired: BoardModel = { ...model, columns: [model.columns[0]!, { ...model.columns[2]!, role: 'done' }] };
    const plan = planModel(model, desired, { columns: { 'm-doing': 4 }, options: {}, fields: {} });
    assert.deepEqual(plan.removedColumns, [{ id: 'm-doing', name: 'Em andamento', items: 4 }]);
    assert.ok(plan.changes.includes('Remover a coluna "Em andamento"'));
    const added = validateModel({ ...model, columns: [...model.columns, { id: null, role: null, name: 'Nova', color: 'BLUE', description: '' }] }, model);
    const addPlan = planModel(model, added, { columns: {}, options: {}, fields: {} });
    assert.deepEqual(addPlan.changes, ['Criar a coluna "Nova"']);
  });
});

const github: BoardStructure = {
  columns: [
    { id: 'g-todo', name: 'Todo', color: 'GRAY', description: '' },
    { id: 'g-doing', name: 'Doing', color: 'YELLOW', description: '' },
    { id: 'g-wip', name: 'WIP', color: 'ORANGE', description: '' },
    { id: 'g-done', name: 'Done', color: 'GREEN', description: '' },
  ],
  fields: [
    {
      id: 'g-prio',
      name: 'prioridade',
      options: [
        { id: 'g-p1', name: 'Alta', color: 'RED', description: '' },
        { id: 'g-p2', name: 'Urgente', color: 'RED', description: '' },
        { id: 'g-p3', name: 'Baixa', color: 'GREEN', description: '' },
      ],
    },
    { id: 'g-size', name: 'Tamanho', options: [{ id: 'g-s', name: 'P', color: 'GRAY', description: '' }] },
  ],
};

describe('suggestMapping', () => {
  it('matches by name, then by the role guessed from the column name', () => {
    const mapping = suggestMapping(model, github, 'GITHUB', null);
    assert.deepEqual(mapping.columns, { 'g-todo': 'm-todo', 'g-doing': 'm-doing', 'g-done': 'm-done' });
    assert.equal(mapping.fields['g-prio'], 'm-prio');
    assert.equal(mapping.fields['g-size'], null);
    assert.deepEqual(mapping.options['g-prio'], { 'g-p1': 'm-high', 'g-p2': null, 'g-p3': 'm-low' });
  });

  it('prefers what the board already had', () => {
    const mapping = suggestMapping(model, github, 'GITHUB', { columns: { 'g-wip': 'm-doing' }, fields: {} });
    assert.equal(mapping.columns['g-wip'], 'm-doing');
  });
});

describe('planSync', () => {
  it('merges columns and options into the one with most cards and moves the others first', () => {
    const mapping = suggestMapping(model, github, 'GITHUB', null);
    mapping.columns['g-wip'] = 'm-doing';
    mapping.options['g-prio']!['g-p2'] = 'm-high';
    const items = [item('g-wip'), item('g-wip'), item('g-doing'), item('g-todo', { 'g-prio': 'g-p2', 'g-size': 'g-s' })];
    const plan = planSync(model, github, mapping, 'GITHUB', items);
    assert.deepEqual(plan.columnMoves, { 'g-doing': 'g-wip' });
    assert.deepEqual(plan.desired.columns.map((column) => [column.id, column.name]), [
      ['g-todo', 'A fazer'],
      ['g-wip', 'Em andamento'],
      ['g-done', 'Concluído'],
    ]);
    assert.deepEqual(plan.optionMoves, [{ fieldId: 'g-prio', from: 'g-p1', to: 'g-p2' }]);
    assert.equal(plan.desired.fields.length, 1);
    assert.equal(plan.desired.fields[0]!.name, 'Prioridade');
    assert.deepEqual(plan.lostValues, [{ field: 'Tamanho', option: null, items: 1 }]);
  });

  it('refuses unmapped columns', () => {
    assert.throws(() => planSync(model, github, { columns: {}, fields: {}, options: {} }, 'GITHUB', []));
  });

  it('on GitLab sends todo/done columns to the fixed open/closed columns', () => {
    const gitlab: BoardStructure = {
      columns: [
        { id: 'label:1', name: 'Doing', color: 'YELLOW', description: '' },
        { id: 'label:2', name: 'Done', color: 'GREEN', description: '' },
      ],
      fields: [],
    };
    const plan = planSync(model, gitlab, suggestMapping(model, gitlab, 'GITLAB', null), 'GITLAB', [item('label:2')]);
    assert.deepEqual(plan.columnMoves, { 'label:2': 'closed' });
    assert.deepEqual(plan.desired.columns.map((column) => [column.id, column.name]), [['label:1', 'Em andamento']]);
  });
});

describe('after applying', () => {
  it('maps by name, derives the agent roles and recognizes a board that follows the model', () => {
    const applied: BoardStructure = {
      columns: [
        { id: 'g-todo', name: 'A fazer', color: 'GRAY', description: '' },
        { id: 'g-wip', name: 'Em andamento', color: 'YELLOW', description: '' },
        { id: 'g-done', name: 'Concluído', color: 'GREEN', description: '' },
      ],
      fields: [
        {
          id: 'g-prio',
          name: 'Prioridade',
          options: [
            { id: 'g-p2', name: 'Alta', color: 'RED', description: '' },
            { id: 'g-p3', name: 'Baixa', color: 'GREEN', description: '' },
          ],
        },
      ],
    };
    const map = mapByName(model, applied, 'GITHUB');
    assert.deepEqual(statusMapFrom(model, map, 'GITHUB'), { todo: 'g-todo', inProgress: 'g-wip', done: 'g-done' });
    assert.equal(followsModel(model, applied, map, 'GITHUB'), true);
    const drifted = { ...applied, columns: [...applied.columns, { id: 'g-new', name: 'Extra', color: 'GRAY' as const, description: '' }] };
    assert.equal(followsModel(model, drifted, map, 'GITHUB'), false);
    assert.equal(followsModel(model, { ...applied, columns: applied.columns.map((column) => ({ ...column, color: 'PINK' as const })) }, map, 'GITHUB'), false);
  });

  it('GitLab roles todo/done point to the fixed columns', () => {
    const map = mapByName(model, { columns: [{ id: 'label:1', name: 'Em andamento', color: 'YELLOW', description: '' }], fields: [] }, 'GITLAB');
    assert.deepEqual(statusMapFrom(model, map, 'GITLAB'), { todo: 'open', inProgress: 'label:1', done: 'closed' });
    assert.deepEqual(modelAsProviderStructure(model, 'GITLAB').columns.map((column) => column.name), ['Em andamento']);
  });
});
