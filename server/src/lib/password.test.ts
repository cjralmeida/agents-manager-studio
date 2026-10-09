import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from './password.js';

describe('password', () => {
  it('verifies the right password only, with a different salt each time', async () => {
    const first = await hashPassword('senha-de-teste-123');
    const second = await hashPassword('senha-de-teste-123');
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('senha-de-teste-123', first), true);
    assert.equal(await verifyPassword('senha-de-teste-124', first), false);
    assert.equal(await verifyPassword('qualquer', 'texto-invalido'), false);
  });

  it('generates passwords of the requested size from the safe alphabet', () => {
    const password = generatePassword(24);
    assert.equal(password.length, 24);
    assert.match(password, /^[A-HJ-NP-Za-km-z2-9]+$/);
    assert.notEqual(generatePassword(), generatePassword());
  });

  it('asks for at least 10 characters', () => {
    assert.notEqual(passwordProblem('curta'), null);
    assert.equal(passwordProblem('suficientemente-longa'), null);
  });
});
