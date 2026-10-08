import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardField } from '../boards/types.js';
import { findByName, resolveColumn, resolveFields } from './resolve.js';

const option = (id: string, name: string) => ({ id, name, color: '#000000', description: null });
const fields: BoardField[] = [
  { id: 'tipo', name: 'Tipo', options: [option('bug', 'Bug'), option('doc', 'Documentação')] },
  { id: 'prio', name: 'Prioridade', options: [option('p1', 'P1 - Alta'), option('p2', 'P2 - Média')] },
];

describe('findByName', () => {
  it('ignores case and accents, and accepts a prefix', () => {
    assert.equal(findByName(fields[0]!.options, 'documentacao')?.id, 'doc');
    assert.equal(findByName(fields[1]!.options, 'p1')?.id, 'p1');
    assert.equal(findByName(fields[1]!.options, 'P3'), undefined);
  });
});

describe('resolveFields', () => {
  it('maps names to ids and reports unknown ones', () => {
    const { resolved, errors } = resolveFields(fields, { tipo: 'bug', Prioridade: 'P2', Area: 'Backend', Tipo: 'Épico' });
    assert.deepEqual(resolved, { tipo: 'bug', prio: 'p2' });
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /Campo "Area" não existe/);
    assert.match(errors[1]!, /"Épico" não é opção de Tipo/);
  });
});

describe('resolveColumn', () => {
  it('finds a column or explains the valid ones', () => {
    const columns = [option('a', 'A fazer'), option('v', 'Em validação')];
    assert.equal(resolveColumn(columns, 'em validacao').id, 'v');
    assert.throws(() => resolveColumn(columns, 'Feito'), /Colunas: A fazer, Em validação/);
  });
});
