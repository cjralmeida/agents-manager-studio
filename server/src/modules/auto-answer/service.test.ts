import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAnswer } from './service.js';

describe('chooseAnswer', () => {
  it('prefers the recommended option, then the approval, then the first option', () => {
    assert.equal(chooseAnswer({ question: 'q', options: [{ label: 'A' }, { label: 'B (Recomendado)' }] }), 'B (Recomendado)');
    assert.equal(chooseAnswer({ question: 'q', options: [{ label: 'Ajustar' }, { label: 'Aprovar' }] }), 'Aprovar');
    assert.equal(chooseAnswer({ question: 'q', options: [{ label: 'X', description: 'opção recomendada' }, { label: 'Y' }] }), 'X');
    assert.equal(chooseAnswer({ question: 'q', options: [{ label: 'Primeira' }, { label: 'Segunda' }] }), 'Primeira');
    assert.equal(chooseAnswer({ question: 'q' }), 'Siga com a opção que você recomenda.');
  });
});
