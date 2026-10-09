import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectStatusMap, roleFromName } from './roles.js';

const option = (id: string, name: string) => ({ id, name, color: '#000000', description: null });

describe('detectStatusMap', () => {
  it('maps the Studio template columns', () => {
    const columns = [
      option('a', 'A fazer'),
      option('b', 'Em andamento'),
      option('c', 'Em validação'),
      option('d', 'Concluído'),
      option('e', 'Aguardando aprovação'),
    ];
    assert.deepEqual(detectStatusMap(columns), { todo: 'a', inProgress: 'b', review: 'c', done: 'd', blocked: 'e' });
  });

  it('maps the GitHub default columns', () => {
    const columns = [option('1', 'Todo'), option('2', 'In Progress'), option('3', 'Done')];
    assert.deepEqual(detectStatusMap(columns), { todo: '1', inProgress: '2', done: '3' });
  });

  it('falls back to first and last columns for todo and done', () => {
    const columns = [option('x', 'Ideias'), option('y', 'Agora'), option('z', 'Arquivo')];
    assert.deepEqual(detectStatusMap(columns), { todo: 'x', done: 'z' });
  });
});

describe('roleFromName', () => {
  it('suggests a role only when the name says so', () => {
    assert.equal(roleFromName('Doing'), 'inProgress');
    assert.equal(roleFromName('Aguardando aprovação'), 'blocked');
    assert.equal(roleFromName('WIP'), null);
  });
});
