import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardField, BoardItem } from '../boards/types.js';
import { matchesRule, pickTasks, type TaskRule, taskPrompt } from './match.js';

const priority: BoardField = {
  id: 'prio',
  name: 'Prioridade',
  options: ['P0', 'P1', 'P2'].map((name) => ({ id: name, name, color: '#000000', description: null })),
};

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'i1',
    title: 'Corrigir login',
    body: '### Objetivo\nCorrigir.',
    url: 'https://github.com/org/repo/issues/7',
    number: 7,
    repository: 'org/repo',
    isDraft: false,
    isClosed: false,
    columnId: 'todo',
    fields: { tipo: 'bug', prio: 'P1' },
    assignees: [],
    pullRequests: [],
    updatedAt: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

const rule: TaskRule = { fieldFilters: { tipo: ['bug'] }, repositories: [], columnId: 'todo', onlyUnassigned: true };

describe('matchesRule', () => {
  it('accepts a task of the watched column with the filtered field values', () => {
    assert.equal(matchesRule(item(), rule), true);
  });

  it('rejects other columns, other field values, drafts and assigned tasks', () => {
    assert.equal(matchesRule(item({ columnId: 'doing' }), rule), false);
    assert.equal(matchesRule(item({ fields: { tipo: 'feature' } }), rule), false);
    assert.equal(matchesRule(item({ fields: {} }), rule), false);
    assert.equal(matchesRule(item({ repository: null, isDraft: true }), rule), false);
    assert.equal(matchesRule(item({ assignees: ['someone'] }), rule), false);
    assert.equal(matchesRule(item({ assignees: ['someone'] }), { ...rule, onlyUnassigned: false }), true);
  });

  it('filters by repository, ignoring case', () => {
    assert.equal(matchesRule(item(), { ...rule, repositories: ['ORG/repo'] }), true);
    assert.equal(matchesRule(item(), { ...rule, repositories: ['org/other'] }), false);
  });

  it('ignores empty filters and needs a column', () => {
    assert.equal(matchesRule(item({ fields: {} }), { ...rule, fieldFilters: { tipo: [] } }), true);
    assert.equal(matchesRule(item(), { ...rule, columnId: null }), false);
  });
});

describe('pickTasks', () => {
  it('orders by priority, then oldest first', () => {
    const items = [
      item({ id: 'p2', fields: { tipo: 'bug', prio: 'P2' } }),
      item({ id: 'p0-new', fields: { tipo: 'bug', prio: 'P0' }, updatedAt: '2026-10-05T00:00:00Z' }),
      item({ id: 'p0-old', fields: { tipo: 'bug', prio: 'P0' }, updatedAt: '2026-10-02T00:00:00Z' }),
      item({ id: 'none', fields: { tipo: 'bug' } }),
    ];
    assert.deepEqual(
      pickTasks(items, [priority], rule).map((entry) => entry.id),
      ['p0-old', 'p0-new', 'p2', 'none'],
    );
  });
});

describe('taskPrompt', () => {
  it('includes the task and the extra instructions', () => {
    const prompt = taskPrompt(item(), 'Rode os testes antes de terminar.');
    assert.match(prompt, /^Resolva a tarefa org\/repo#7: Corrigir login/);
    assert.match(prompt, /Instruções extras:\nRode os testes antes de terminar\.$/);
    assert.doesNotMatch(taskPrompt(item(), '  '), /Instruções/);
  });
});
