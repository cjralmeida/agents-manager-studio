import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { patchSchema } from './validation.js';

describe('patchSchema', () => {
  const schema = z.object({ name: z.string(), tools: z.array(z.string()).default([]), model: z.string().default('sonnet') }).strict();

  it('keeps only the fields that were sent', () => {
    assert.deepEqual(patchSchema(schema).parse({ name: 'scout' }), { name: 'scout' });
  });

  it('still validates the fields that were sent', () => {
    assert.equal(patchSchema(schema).safeParse({ tools: 'board' }).success, false);
    assert.equal(patchSchema(schema).safeParse({ unknown: 1 }).success, false);
  });
});
