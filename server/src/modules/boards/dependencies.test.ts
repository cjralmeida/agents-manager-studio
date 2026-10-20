import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dependenciesDelivered, dependencyRefs, releasableItems } from './dependencies.js';
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

  it('counts a dependency in homologation as delivered', () => {
    const items = [item('org/api', 1, 'hom'), item('org/ui', 3, 'blocked', 'Depende de: org/api#1')];
    assert.deepEqual(releasableItems(items, { ...statusMap, homologation: 'hom' }).map((entry) => entry.id), ['org/ui#3']);
    assert.deepEqual(releasableItems(items, statusMap), []);
  });

  it('does nothing without the roles it needs', () => {
    assert.deepEqual(releasableItems([item('org/ui', 3, 'blocked', 'Depende de: org/api#1')], { todo: 'todo' }), []);
  });
});

describe('dependenciesDelivered', () => {
  const statusMap = { todo: 'todo', blocked: 'blocked', done: 'done', homologation: 'hom' };

  it('lets a task without dependencies, or with all of them delivered, start', () => {
    const items = [item('org/api', 1, 'done'), item('org/api', 2, 'hom'), item('org/ui', 3, 'todo', 'Depende de: org/api#1, org/api#2'), item('org/ui', 4, 'todo')];
    const delivered = dependenciesDelivered(items, statusMap);
    assert.equal(delivered(items[2]!), true);
    assert.equal(delivered(items[3]!), true);
  });

  it('holds a task in "todo" while a dependency is open or unknown', () => {
    const items = [item('org/api', 1, 'inProgress'), item('org/ui', 3, 'todo', 'Depende de: org/api#1'), item('org/ui', 4, 'todo', 'Depende de: org/api#9')];
    const delivered = dependenciesDelivered(items, statusMap);
    assert.equal(delivered(items[1]!), false);
    assert.equal(delivered(items[2]!), false);
  });

  it('understands a short ref ("repo#12") when one repository on the board ends with it', () => {
    const items = [
      item('group/globalfarm/globalfarm', 50, 'done'),
      item('group/globalfarm/globalfarm', 97, 'todo', '- Depende de / relacionado a: globalfarm#50 (CRUD)'),
      item('other/globalfarm', 7, 'inProgress'),
      item('group/globalfarm/globalfarm', 98, 'todo', 'Depende de: globalfarm#7'),
    ];
    const delivered = dependenciesDelivered(items, statusMap);
    assert.equal(delivered(items[1]!), true);
    // Only other/globalfarm has a #7: the short ref resolves to it, and it is still open.
    assert.equal(delivered(items[3]!), false);
  });

  it('counts a ref missing from a repository with every open issue on the board as closed', () => {
    const items = [item('group/front/app', 53, 'blocked', 'Depende de: app#2, group/api/api#19, elsewhere/repo#4')];
    // Without the list, a missing ref waits.
    assert.equal(dependenciesDelivered(items, statusMap)(items[0]!), false);
    // app#2 and api#19 are closed long ago; elsewhere/repo is not fully listed, so #4 still waits.
    assert.equal(dependenciesDelivered(items, statusMap, ['group/front/app', 'group/api/api'])(items[0]!), false);
    assert.equal(dependenciesDelivered(items, statusMap, ['group/front/app', 'group/api/api', 'elsewhere/repo'])(items[0]!), true);
  });
});
