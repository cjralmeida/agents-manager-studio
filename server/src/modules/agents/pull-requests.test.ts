import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNoCommitsRefusal } from './pull-requests.js';

describe('isNoCommitsRefusal', () => {
  it('recognizes the GitHub refusal of a branch with nothing to merge', () => {
    assert.equal(isNoCommitsRefusal('GitHub recusou o pull request: No commits between main and agent/programar-the-golden-mug-regre-53812d96'), true);
  });

  it('ignores other refusals', () => {
    assert.equal(isNoCommitsRefusal('GitHub recusou o pull request: Validation Failed'), false);
    assert.equal(isNoCommitsRefusal('O PR/MR não pôde ser mesclado: provavelmente tem conflitos com a branch de destino (405).'), false);
  });
});
