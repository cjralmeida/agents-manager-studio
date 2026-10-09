import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dependencyRefs, releasableItems } from './dependencies.js';
import type { BoardItem } from './types.js';

const item = (repository: string, number: number, columnId: string, body = '', isClosed = false) =>
  ({ id: `${repository}#${number}`, repository, number, columnId, body, isClosed, fields: {} }) as unknown as BoardItem;

describe('dependencyRefs', () => {
  it('reads the refs of the "Depende de" line in its usual spellings', () => {
    assert.deepEqual(dependencyRefs('## Referências\n- Depende de: org/api#12, org/ui#3'), ['org/api#12', 'org/ui#3']);
    assert.deepEqual(dependencyRefs('**Depende de:** group/sub/api#7'), ['group/sub/api#7']);
    assert.deepEqual(dependencyRefs('depende de api#2 e api#4'), ['api#2', 'api#4']);
    assert.deepEqual(dependencyRefs('Sem dependências. Ver org/api#12.'), []);
  });
});

describe('releasableItems', () => {
  const statusMap = { todo: 'todo', blocked: 'blocked', done: 'done' };

  it('releases a blocked task once every dependency is done or closed', () => {
    const items = [
      item('org/api', 1, 'done'),
      item('org/api', 2, 'review', '', true),
      item('org/ui', 3, 'blocked', 'Depende de: org/api#1, org/api#2'),
      item('org/ui', 4, 'blocked', 'Depende de: org/api#1, org/api#9'),
      item('org/ui', 5, 'blocked', 'Aguardando decisão do cliente'),
      item('org/ui', 6, 'todo', 'Depende de: org/api#1'),
    ];
    assert.deepEqual(
      releasableItems(items, statusMap).map((entry) => entry.id),
      ['org/ui#3'],
    );
  });

  it('keeps it blocked while a dependency is open', () => {
    const items = [item('org/api', 1, 'inProgress'), item('org/ui', 3, 'blocked', 'Depende de: org/api#1')];
    assert.deepEqual(releasableItems(items, statusMap), []);
  });

  it('does nothing without the roles it needs', () => {
    assert.deepEqual(releasableItems([item('org/ui', 3, 'blocked', 'Depende de: org/api#1')], { todo: 'todo' }), []);
  });
});
