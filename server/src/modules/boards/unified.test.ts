import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardModel } from './model.js';
import type { BoardItem } from './types.js';
import {
  type SourceMapping,
  joinedItemId,
  modelLayout,
  splitItemId,
  toJoinedItem,
  toModelColumn,
  toModelFields,
  toSourceColumn,
  toSourceField,
  toSourceFields,
} from './unified.js';

const model: BoardModel = {
  columns: [
    { id: 'm-todo', role: 'todo', name: 'A fazer', color: 'GRAY', description: '' },
    { id: 'm-doing', role: 'inProgress', name: 'Em andamento', color: 'YELLOW', description: '' },
    { id: 'm-done', role: 'done', name: 'Concluído', color: 'GREEN', description: '' },
  ],
  fields: [
    {
      id: 'm-area',
      name: 'Área',
      options: [
        { id: 'm-back', name: 'Backend', color: 'BLUE', description: '' },
        { id: 'm-front', name: 'Frontend', color: 'PINK', description: '' },
      ],
    },
  ],
};

const github: SourceMapping = {
  provider: 'GITHUB',
  modelMap: {
    columns: { 'g-todo': 'm-todo', 'g-doing': 'm-doing', 'g-done': 'm-done' },
    fields: { 'g-area': { model: 'm-area', options: { 'g-back': 'm-back', 'g-front': 'm-front' } } },
  },
};
// On GitLab "todo" and "done" are the open/closed issues, not labels.
const gitlab: SourceMapping = {
  provider: 'GITLAB',
  modelMap: { columns: { 'l-doing': 'm-doing' }, fields: { 'l-area': { model: 'm-area', options: { 'l-back': 'm-back' } } } },
};
const studio: SourceMapping = { provider: 'STUDIO', modelMap: null };

describe('joined item ids', () => {
  it('splits at the first colon, keeping colons of the source id', () => {
    assert.deepEqual(splitItemId(joinedItemId('src-1', '12:34')), { sourceId: 'src-1', itemId: '12:34' });
    assert.equal(splitItemId('sem-fonte'), null);
  });
});

describe('columns', () => {
  it('translates both ways through the map, the GitLab fixed columns and Studio ids', () => {
    assert.equal(toModelColumn(github, model, 'g-doing'), 'm-doing');
    assert.equal(toModelColumn(gitlab, model, 'closed'), 'm-done');
    assert.equal(toModelColumn(gitlab, model, 'unknown'), null);
    assert.equal(toModelColumn(studio, model, 'm-doing'), 'm-doing');
    assert.equal(toSourceColumn(github, model, 'm-done'), 'g-done');
    assert.equal(toSourceColumn(gitlab, model, 'm-todo'), 'open');
    assert.equal(toSourceColumn(gitlab, model, 'm-doing'), 'l-doing');
    assert.equal(toSourceColumn(studio, model, 'm-done'), 'm-done');
    assert.equal(toSourceColumn(github, model, 'nope'), null);
  });
});

describe('fields', () => {
  it('translates values and leaves out what the other side lacks', () => {
    assert.deepEqual(toModelFields(github, { 'g-area': 'g-front', other: 'x' }), { 'm-area': 'm-front' });
    assert.deepEqual(toSourceField(github, 'm-area', 'm-back'), { fieldId: 'g-area', optionId: 'g-back' });
    assert.deepEqual(toSourceField(github, 'm-area', null), { fieldId: 'g-area', optionId: null });
    assert.equal(toSourceField(gitlab, 'm-area', 'm-front'), null);
    assert.deepEqual(toSourceFields(gitlab, { 'm-area': 'm-front' }), {});
    assert.deepEqual(toSourceFields(github, { 'm-area': 'm-front' }), { 'g-area': 'g-front' });
  });
});

describe('toJoinedItem', () => {
  it('gives the item the joined id, model column and fields', () => {
    const item = { id: 'PVTI_1', columnId: 'g-doing', fields: { 'g-area': 'g-back' } } as unknown as BoardItem;
    const joined = toJoinedItem('src-gh', github, model, item);
    assert.equal(joined.id, 'src-gh:PVTI_1');
    assert.equal(joined.columnId, 'm-doing');
    assert.deepEqual(joined.fields, { 'm-area': 'm-back' });
    assert.equal(joined.sourceId, 'src-gh');
  });
});

describe('modelLayout', () => {
  it('maps each role to its model column', () => {
    assert.deepEqual(modelLayout(model).statusMap, { todo: 'm-todo', inProgress: 'm-doing', done: 'm-done' });
  });
});
