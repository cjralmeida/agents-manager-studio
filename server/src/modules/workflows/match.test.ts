import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardField, BoardItem } from '../boards/types.js';
import {
  awaitingDecision,
  decisionPrompt,
  featureIdOf,
  featurePrompt,
  featuresReady,
  frontendPrompt,
  frontendTasksReady,
  homologationRetestDue,
  lastRunHoldsTask,
  matchesRule,
  packageFiles,
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

describe('pickTasks order', () => {
  it('does first what an urgent task waits for, then the lowest number', () => {
    const items = [
      item({ id: 'api9', number: 9, repository: 'org/api', fields: { prio: 'P2' }, body: 'API' }),
      item({ id: 'api5', number: 5, repository: 'org/api', fields: { prio: 'P2' }, body: 'API' }),
      item({ id: 'api3', number: 3, repository: 'org/api', fields: { prio: 'P1' }, body: 'Depende de: org/api#9' }),
    ];
    assert.deepEqual(pickTasks(items, [priority], { ...rule, fieldFilters: {} }).map((entry) => entry.id), ['api3', 'api9', 'api5']);
  });

  it('takes fixes (back with a test report) before new work, except a new P0 before a fix that is not P0', () => {
    const report = 'API\n\n## Relatório de HOM — 2026-10-15\nHOM-01 falhou.';
    const items = [
      item({ id: 'new-p1', number: 1, fields: { prio: 'P1' }, body: 'API' }),
      item({ id: 'fix-p2', number: 2, fields: { prio: 'P2' }, body: report }),
      item({ id: 'new-p0', number: 3, fields: { prio: 'P0' }, body: 'API' }),
      item({ id: 'fix-p0', number: 4, fields: { prio: 'P0' }, body: report }),
    ];
    assert.deepEqual(pickTasks(items, [priority], { ...rule, fieldFilters: {} }).map((entry) => entry.id), ['fix-p0', 'new-p0', 'fix-p2', 'new-p1']);
    assert.match(taskPrompt(items[1]!, ''), /CORREÇÃO/);
    assert.doesNotMatch(taskPrompt(items[0]!, ''), /CORREÇÃO/);
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

  it('takes the open tasks of each feature that are in homologation', () => {
    const items = [
      task('a', '[FUNC-001] Backend — API', 'hom'),
      task('b', '[FUNC-001] Frontend — tela', 'hom'),
      task('c', '[FUNC-001] Ajuste antigo', 'done'),
      task('d', '[FUNC-002] Backend — API', 'hom'),
      task('e', '[FUNC-002] Frontend — tela', 'doing'),
      task('f', 'Sem funcionalidade', 'hom'),
    ];
    const ready = featuresReady(items, input);
    // "Sem funcionalidade" is in homologation too: it is tested on its own.
    assert.deepEqual(ready.map((feature) => feature.featureId), ['FUNC-001', 'FUNC-002', 'org/repo#7']);
    assert.deepEqual(ready[0]!.tasks.map((entry) => entry.id), ['a', 'b']);
    assert.deepEqual(ready[1]!.tasks.map((entry) => entry.id), ['d']);
    assert.deepEqual(ready[1]!.pending.map((entry) => entry.id), ['e']);
  });

  it('tests the tasks already in homologation without waiting for the rest of the feature', () => {
    const items = [task('a', '[FUNC-030] API — busca', 'hom'), task('b', '[FUNC-030] API — tarefas', 'todo'), task('c', '[FUNC-031] API', 'doing')];
    const ready = featuresReady(items, input);
    assert.deepEqual(ready.map((feature) => feature.featureId), ['FUNC-030']);
    assert.deepEqual(ready[0]!.tasks.map((entry) => entry.id), ['a']);
    assert.deepEqual(ready[0]!.pending.map((entry) => entry.id), ['b']);
    assert.match(featurePrompt(ready[0]!), /que já estão em homologação/);
    assert.match(featurePrompt(ready[0]!), /Não teste estas/);
  });

  it('tests a task outside any feature on its own once it is in homologation', () => {
    const items = [task('t', '[Transversal] API — memória', 'hom'), task('u', '[Transversal] API — robustez', 'todo')];
    const ready = featuresReady(items, input);
    assert.deepEqual(ready.map((feature) => feature.tasks.map((entry) => entry.id)), [['t']]);
    assert.match(featurePrompt(ready[0]!), /não faz parte de uma funcionalidade/);
  });

  it('ignores closed tasks and other repositories', () => {
    const items = [
      task('a', '[FUNC-003] Backend', 'hom'),
      task('b', '[FUNC-003] Frontend', 'doing', { isClosed: true }),
      task('c', '[FUNC-003] Mobile', 'doing', { repository: 'org/app' }),
    ];
    assert.deepEqual(featuresReady(items, { ...input, repositories: ['org/repo'] })[0]!.pending, []);
    assert.deepEqual(featuresReady(items, input)[0]!.pending.map((entry) => entry.id), ['c']);
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

  it('tests a screen only after the screen it builds on is approved', () => {
    const items = [api(1, 'hom'), screen(10, 'hom', 'org/front#9'), screen(9, 'hom', 'org/api#1')];
    assert.deepEqual(frontendTasksReady(items, input).map((entry) => entry.task.id), ['front9']);
    const approved = [api(1, 'hom'), screen(10, 'hom', 'org/front#9'), screen(9, 'done', 'org/api#1')];
    assert.deepEqual(frontendTasksReady(approved, input).map((entry) => entry.task.id), ['front10']);
  });

  it('takes the highest priority first, then the lowest number', () => {
    const items = [api(1, 'hom'), { ...screen(12, 'hom', 'org/api#1'), fields: { prio: 'P2' } }, { ...screen(11, 'hom', 'org/api#1'), fields: { prio: 'P0' } }, { ...screen(10, 'hom', 'org/api#1'), fields: { prio: 'P2' } }];
    assert.deepEqual(frontendTasksReady(items, input, [priority]).map((entry) => entry.task.id), ['front11', 'front10', 'front12']);
  });

  it('ignores other repositories and screens depending on tasks missing from the board', () => {
    const items = [api(1, 'hom'), screen(10, 'hom', 'org/api#9'), item({ id: 'x', repository: 'org/other', columnId: 'hom', body: 'Depende de: org/api#1' })];
    assert.deepEqual(frontendTasksReady(items, input), []);
  });

  it('leaves the backend to the API test and opens a bug instead of reopening a concluded API', () => {
    const items = [api(1, 'hom'), screen(10, 'hom', 'org/api#1')];
    const [ready] = frontendTasksReady(items, input);
    const prompt = frontendPrompt(ready!, items, 'done');
    assert.match(prompt, /Não mova as tarefas de backend/);
    assert.match(prompt, /Se ela já está em "Concluído", não a reabra: crie uma tarefa de bug/);
    assert.match(prompt, /org\/front#10 fica em homologação e ganha \(ou mantém\) na linha "Depende de:"/);
  });

  it('concludes the tested API tasks even when a screen that uses them is still to come', () => {
    const items = [api(1, 'hom'), screen(10, 'todo', 'org/api#1')];
    const [feature] = featuresReady([items[0]!], { homologationColumnId: 'hom', doneColumnId: 'done', repositories: [] });
    assert.match(featurePrompt(feature!, items, 'done'), /Aprovado: mova para "Concluído" todas as tarefas testadas aqui/);
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
    assert.match(prompt, /inclusive as telas em homologação \(org\/front#10\)/);
  });
});

describe('awaitingDecision with the decision field', () => {
  const decision: BoardField = {
    id: 'dec',
    name: 'Decisão',
    options: [{ id: 'wait', name: 'Aguardando decisão', color: '#ff0000', description: null }],
  };

  it('takes only the tasks marked as waiting for a decision when the board has the field', () => {
    const items = [
      item({ id: 'a', columnId: 'blocked', fields: { dec: 'wait' } }),
      item({ id: 'b', columnId: 'blocked', fields: {} }),
      item({ id: 'c', columnId: 'blocked', fields: {}, body: 'Depende de: org/repo#1' }),
      item({ id: 'd', columnId: 'todo', fields: { dec: 'wait' } }),
    ];
    assert.deepEqual(awaitingDecision(items, 'blocked', [], [decision]).map((entry) => entry.id), ['a']);
  });

  it('tells the agent to clear the mark after deciding', () => {
    assert.match(decisionPrompt(item({ columnId: 'blocked' }), [decision]), /limpe o campo "Decisão"/);
  });
});

describe('packageFiles', () => {
  it('reads the change packages a step result names, once each', () => {
    const result = 'Documentei a FUNC-031 e o pacote mudancas/MUD-012-FUNC-031.md (ver mudancas/MUD-012-FUNC-031.md); ADR em decisoes/ADR-011.md';
    assert.deepEqual(packageFiles(result), ['mudancas/MUD-012-FUNC-031.md']);
    assert.deepEqual(packageFiles('Pacotes MUD-003.md e docs/mudancas/MUD-004-FUNC-002.md'), ['MUD-003.md', 'docs/mudancas/MUD-004-FUNC-002.md']);
    assert.deepEqual(packageFiles('Sem pacote: só o MUD-005 citado'), []);
  });
});

describe('lastRunHoldsTask', () => {
  const finishedAt = new Date('2026-10-27T20:24:00Z');
  const before = '2026-10-27T20:23:49Z';
  const after = '2026-10-27T20:30:00Z';

  it('holds a task while its run is going', () => {
    assert.equal(lastRunHoldsTask({ status: 'RUNNING', finishedAt: null, trigger: {} }, after, false), true);
  });

  it('holds a task whose own run failed until someone changes it', () => {
    const run = { status: 'FAILED', finishedAt, trigger: { taskItemId: 'x', title: 't' } };
    assert.equal(lastRunHoldsTask(run, before, false), true);
    assert.equal(lastRunHoldsTask(run, after, false), false);
  });

  it('does not hold a task after a machine failure or a completed run', () => {
    assert.equal(lastRunHoldsTask({ status: 'FAILED', finishedAt, trigger: {} }, before, true), false);
    assert.equal(lastRunHoldsTask({ status: 'COMPLETED', finishedAt, trigger: {} }, before, false), false);
  });

  it('does not hold a task a homologation test sent back with its report', () => {
    // globalfarm front #138: the screen test moved it to "A fazer" (20:23:49) before the run ended (20:24).
    const run = { status: 'FAILED', finishedAt, trigger: { taskItemId: 'x', title: 't', signature: 'abc' } };
    assert.equal(lastRunHoldsTask(run, before, false), false);
  });
});

describe('homologationRetestDue', () => {
  const now = Date.parse('2026-10-27T21:00:00Z');
  const after = 30 * 60_000;

  it('tests again a while after a test that failed or completed without deciding', () => {
    for (const status of ['FAILED', 'COMPLETED']) {
      assert.equal(homologationRetestDue({ status, finishedAt: new Date('2026-10-27T20:00:00Z') }, now, after), true);
      assert.equal(homologationRetestDue({ status, finishedAt: new Date('2026-10-27T20:45:00Z') }, now, after), false);
    }
  });

  it('does not test again a cancelled or unfinished run', () => {
    assert.equal(homologationRetestDue({ status: 'CANCELLED', finishedAt: new Date('2026-10-27T20:00:00Z') }, now, after), false);
    assert.equal(homologationRetestDue({ status: 'FAILED', finishedAt: null }, now, after), false);
  });
});
