import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderEnvFile, variableKeyError } from './env-file.js';

describe('variableKeyError', () => {
  it('accepts plain names', () => {
    assert.equal(variableKeyError('HOM_USER_EMAIL'), null);
    assert.equal(variableKeyError('_x1'), null);
  });

  it('rejects invalid and reserved names', () => {
    assert.match(variableKeyError('1A') ?? '', /letras/);
    assert.match(variableKeyError('A-B') ?? '', /letras/);
    assert.match(variableKeyError('PATH') ?? '', /reservado/);
    assert.match(variableKeyError('claude_code_oauth_token') ?? '', /reservado/);
    assert.match(variableKeyError('TEST_DATABASE_URL') ?? '', /reservado/);
  });
});

describe('renderEnvFile', () => {
  it('single-quotes values so the shell never expands them', () => {
    const file = renderEnvFile([
      { key: 'A', value: "it's $HOME `x`" },
      { key: 'B', value: 'linha1\nlinha2' },
    ]);
    assert.ok(file.includes(`A='it'\\''s $HOME \`x\`'`));
    assert.ok(file.includes("B='linha1\nlinha2'"));
  });
});
