import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardItem } from '../boards/types.js';
import { flagTaskRefs, flagTasksDone } from './flag-sweep.js';

const item = (repository: string, number: number, columnId: string, isClosed = false) =>
  ({ id: `${repository}#${number}`, repository, number, columnId, body: '', isClosed, fields: {} }) as unknown as BoardItem;
const statusMap = { todo: 'todo', done: 'done', homologation: 'hom' };

describe('flagTaskRefs', () => {
  it('reads the task refs a decision names, once each', () => {
    assert.deepEqual(flagTaskRefs('globalfarm#127 (GET /rest/aplicacoes lento) reprovou 4 vezes; ver globalfarm#127'), ['globalfarm#127']);
    assert.deepEqual(flagTaskRefs('Telas de Compras (gf-novo-oficial#27) e org/api#3'), ['gf-novo-oficial#27', 'org/api#3']);
    assert.deepEqual(flagTaskRefs('Teste da API do #118 apagou dados de outra rodada'), []);
  });
});

describe('flagTasksDone', () => {
  const items = [item('g/globalfarm', 127, 'done'), item('g/globalfarm', 40, 'todo'), item('g/gf-novo-oficial', 27, 'hom'), item('g/globalfarm', 9, 'review', true)];

  it('dismisses a decision when every task it names is done or closed', () => {
    assert.equal(flagTasksDone('globalfarm#127 reprovou 4 vezes em HOM', items, statusMap), true);
    assert.equal(flagTasksDone('globalfarm#9 e globalfarm#127', items, statusMap), true);
  });

  it('keeps it while a task is open, still in homologation, or when it names no task', () => {
    assert.equal(flagTasksDone('globalfarm#40 falha em loop; lotes globalfarm#127', items, statusMap), false);
    assert.equal(flagTasksDone('gf-novo-oficial#27 fora do front de HOM', items, statusMap), false);
    assert.equal(flagTasksDone('O testador apagou 3 registros de outra rodada', items, statusMap), false);
  });

  it('counts a task off the board as done only when its repository has every open issue listed', () => {
    assert.equal(flagTasksDone('globalfarm#3 antiga', items, statusMap, ['g/globalfarm']), true);
    assert.equal(flagTasksDone('outro#3 antiga', items, statusMap, ['g/globalfarm']), false);
  });
});
