import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createSecretBox, secretHint } from './crypto.js';

describe('createSecretBox', () => {
  const box = createSecretBox(randomBytes(32).toString('hex'));

  it('round-trips a secret without storing it in clear text', () => {
    const encrypted = box.encrypt('ghp_secret-token');
    assert.ok(!encrypted.includes('ghp_secret-token'));
    assert.equal(box.decrypt(encrypted), 'ghp_secret-token');
  });

  it('uses a random iv for each encryption', () => {
    assert.notEqual(box.encrypt('same'), box.encrypt('same'));
  });

  it('rejects payloads encrypted with another key', () => {
    const other = createSecretBox(randomBytes(32).toString('hex'));
    assert.throws(() => box.decrypt(other.encrypt('secret')));
  });

  it('rejects keys with the wrong size', () => {
    assert.throws(() => createSecretBox('abcd'));
  });
});

describe('secretHint', () => {
  it('shows only the last four characters', () => {
    assert.equal(secretHint('sk-ant-oat01-abcdef'), '…cdef');
  });
});
