import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardField, BoardItem } from '../boards/types.js';
import {
  awaitingDecision,
  featureIdOf,
  featurePrompt,
  featuresReady,
  frontendPrompt,
  frontendTasksReady,
  matchesRule,
  pickTasks,
  screensUsing,
  type TaskRule,
  taskPrompt,
} from './match.js';

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
    assert.match(prompt, /id no quadro: i1/);
    assert.match(prompt, /Instruções extras:\nRode os testes antes de terminar\.$/);
    assert.doesNotMatch(taskPrompt(item(), '  '), /Instruções/);
  });
});

describe('featuresReady', () => {
  const input = { homologationColumnId: 'hom', doneColumnId: 'done', repositories: [] };
  const task = (id: string, title: string, columnId: string, overrides: Partial<BoardItem> = {}) => item({ id, title, columnId, ...overrides });

  it('reads the feature id from the title', () => {
    assert.equal(featureIdOf('[func-012] Backend — desconto'), 'FUNC-012');
    assert.equal(featureIdOf('Corrigir login'), null);
  });

  it('is ready when every open task of the feature is in homologation', () => {
    const items = [
      task('a', '[FUNC-001] Backend — API', 'hom'),
      task('b', '[FUNC-001] Frontend — tela', 'hom'),
      task('c', '[FUNC-001] Ajuste antigo', 'done'),
      task('d', '[FUNC-002] Backend — API', 'hom'),
      task('e', '[FUNC-002] Frontend — tela', 'doing'),
      task('f', 'Sem funcionalidade', 'hom'),
    ];
    const ready = featuresReady(items, input);
    assert.deepEqual(ready.map((feature) => feature.featureId), ['FUNC-001']);
    assert.deepEqual(ready[0]!.tasks.map((entry) => entry.id), ['a', 'b']);
  });

  it('ignores closed tasks and other repositories', () => {
    const items = [
      task('a', '[FUNC-003] Backend', 'hom'),
      task('b', '[FUNC-003] Frontend', 'doing', { isClosed: true }),
      task('c', '[FUNC-003] Mobile', 'doing', { repository: 'org/app' }),
    ];
    assert.equal(featuresReady(items, { ...input, repositories: ['org/repo'] }).length, 1);
    assert.equal(featuresReady(items, input).length, 0);
  });

  it('changes the signature when a description changes', () => {
    const before = featuresReady([task('a', '[FUNC-004] Backend', 'hom')], input)[0]!.signature;
    const after = featuresReady([task('a', '[FUNC-004] Backend', 'hom', { body: 'com relatório' })], input)[0]!.signature;
    assert.notEqual(before, after);
  });
});

describe('awaitingDecision', () => {
  const blocked = (overrides: Partial<BoardItem>) => item({ columnId: 'blocked', ...overrides });

  it('picks blocked tasks that wait for a decision', () => {
    const items = [blocked({ id: 'a' }), item({ id: 'b' })];
    assert.deepEqual(
      awaitingDecision(items, 'blocked', []).map((entry) => entry.id),
      ['a'],
    );
  });

  it('leaves out tasks that only wait for their dependencies, closed tasks and drafts', () => {
    const items = [
      blocked({ id: 'deps', body: 'Referências\nDepende de: org/repo#3' }),
      blocked({ id: 'closed', isClosed: true }),
      blocked({ id: 'draft', repository: null }),
    ];
    assert.deepEqual(awaitingDecision(items, 'blocked', []), []);
  });

  it('filters by repository', () => {
    const items = [blocked({ id: 'a' }), blocked({ id: 'b', repository: 'org/other' })];
    assert.deepEqual(
      awaitingDecision(items, 'blocked', ['ORG/other']).map((entry) => entry.id),
      ['b'],
    );
  });
});

describe('frontendTasksReady', () => {
  const input = { homologationColumnId: 'hom', doneColumnId: 'done', repositories: ['org/front'] };
  const api = (number: number, columnId: string) =>
    item({ id: `api${number}`, title: `[FUNC-001] API ${number}`, repository: 'org/api', number, columnId, body: 'API' });
  const screen = (number: number, columnId: string, depends: string) =>
    item({ id: `front${number}`, title: `[FUNC-001] Front ${number}`, repository: 'org/front', number, columnId, body: `Tela
- Depende de: ${depends}` });

  it('takes a screen in homologation whose backend is in homologation or done', () => {
    const items = [api(1, 'hom'), api(2, 'done'), api(3, 'doing'), screen(10, 'hom', 'org/api#1, org/api#2'), screen(11, 'hom', 'org/api#3'), screen(12, 'todo', 'org/api#1')];
    const ready = frontendTasksReady(items, input);
    assert.deepEqual(ready.map((entry) => entry.task.id), ['front10']);
    assert.deepEqual(ready[0]!.backend.map((entry) => entry.id), ['api1']);
  });

  it('ignores other repositories and screens depending on tasks missing from the board', () => {
    const items = [api(1, 'hom'), screen(10, 'hom', 'org/api#9'), item({ id: 'x', repository: 'org/other', columnId: 'hom', body: 'Depende de: org/api#1' })];
    assert.deepEqual(frontendTasksReady(items, input), []);
  });

  it('tells the tester to conclude the backend only when no other screen still needs it', () => {
    const items = [api(1, 'hom'), api(2, 'hom'), screen(10, 'hom', 'org/api#1, org/api#2'), screen(11, 'todo', 'org/api#2')];
    const [ready] = frontendTasksReady(items, input);
    const prompt = frontendPrompt(ready!, items, 'done');
    assert.match(prompt, /Mova você mesmo para "Concluído" também: org\/api#1\./);
    assert.match(prompt, /org\/api#2 .* fica em homologação mesmo aprovada: ainda falta testar org\/front#11/);
  });

  it('keeps a feature task used by an untested screen in homologation', () => {
    const items = [api(1, 'hom'), screen(10, 'todo', 'org/api#1')];
    const [feature] = featuresReady([items[0]!], { homologationColumnId: 'hom', doneColumnId: 'done', repositories: [] });
    assert.match(featurePrompt(feature!, items, 'done'), /org\/api#1 .* fica em homologação/);
  });
});

describe('screensUsing', () => {
  const columns = { homologationColumnId: 'hom', doneColumnId: 'done' };
  const api = item({ id: 'api1', title: '[FUNC-001] API', repository: 'org/api', number: 1, columnId: 'hom', body: 'API' });
  const screen = (number: number, columnId: string, overrides: Partial<BoardItem> = {}) =>
    item({ id: `front${number}`, title: `[FUNC-001] Front ${number}`, repository: 'org/front', number, columnId, body: 'Depende de: org/api#1', ...overrides });

  it('takes published screens that use the backend: in homologation or done', () => {
    const items = [api, screen(10, 'hom'), screen(11, 'done'), screen(12, 'todo'), screen(13, 'hom', { body: 'Depende de: org/api#9' })];
    assert.deepEqual(screensUsing(items, [api], columns).map((entry) => entry.id), ['front10', 'front11']);
  });

  it('tells the tester to test through the screens and send back a done screen that broke', () => {
    const items = [api, screen(10, 'hom'), screen(11, 'done'), screen(12, 'todo')];
    const [feature] = featuresReady(items.filter((entry) => entry.repository === 'org/api'), { ...columns, repositories: [] });
    const prompt = featurePrompt(feature!, items, 'done', screensUsing(items, [api], columns));
    assert.match(prompt, /# Telas que usam estas tarefas/);
    assert.match(prompt, /inclusive uma tela que estava em "Concluído"/);
    assert.match(prompt, /e as telas em homologação testadas aqui \(org\/front#10\)/);
    assert.match(prompt, /org\/api#1 .* ainda falta testar org\/front#12/);
  });
});
