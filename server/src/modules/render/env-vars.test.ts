import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnvVars } from './env-vars.js';

describe('parseEnvVars', () => {
  it('accepts values and generated secrets', () => {
    assert.deepEqual(parseEnvVars([{ key: 'LOG_LEVEL', value: 'info' }, { key: 'JWT_SECRET', generate: true }]), [
      { key: 'LOG_LEVEL', value: 'info' },
      { key: 'JWT_SECRET', generate: true },
    ]);
  });

  it('rejects invalid names, duplicates and missing values', () => {
    assert.throws(() => parseEnvVars([]), /ao menos uma/);
    assert.throws(() => parseEnvVars([{ key: '1ABC', value: 'x' }]), /inválido/);
    assert.throws(() => parseEnvVars([{ key: 'A B', value: 'x' }]), /inválido/);
    assert.throws(() => parseEnvVars([{ key: 'A', value: 'x' }, { key: 'A', value: 'y' }]), /mais de uma vez/);
    assert.throws(() => parseEnvVars([{ key: 'A', value: '' }]), /Informe o valor/);
    assert.throws(() => parseEnvVars([{ key: 'A' }]), /generate/);
  });
});
