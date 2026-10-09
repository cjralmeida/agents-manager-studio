import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMergeTarget, assertPushBranch, assertWorkBase } from './branch-guard.js';

const refactor = { name: 'globalfarm', baseBranch: 'refactor/api' };
const free = { name: 'outro', baseBranch: null };

describe('assertWorkBase', () => {
  it('accepts only the project base branch when one is set', () => {
    assert.doesNotThrow(() => assertWorkBase(refactor, 'refactor/api'));
    assert.throws(() => assertWorkBase(refactor, 'master'), /só aceita trabalho de agentes na branch "refactor\/api"/);
    assert.throws(() => assertWorkBase(refactor, 'hom'));
    assert.doesNotThrow(() => assertWorkBase(free, 'develop'));
  });
});

describe('assertPushBranch', () => {
  it('pushes to the agent branch, never to the base', () => {
    assert.doesNotThrow(() => assertPushBranch(refactor, { branch: 'agent/x-1', baseBranch: 'refactor/api' }));
    assert.throws(() => assertPushBranch(refactor, { branch: 'refactor/api', baseBranch: 'refactor/api' }), /só por PR\/MR/);
    assert.throws(() => assertPushBranch(refactor, { branch: 'agent/x-1', baseBranch: 'master' }));
    assert.throws(() => assertPushBranch(free, { branch: 'develop', baseBranch: 'develop' }), /só por PR\/MR/);
  });
});

describe('assertMergeTarget', () => {
  it('merges only PRs whose real target is the allowed base', () => {
    assert.doesNotThrow(() => assertMergeTarget(refactor, 'refactor/api', 'refactor/api', 'O MR !3'));
    assert.throws(() => assertMergeTarget(refactor, 'refactor/api', 'master', 'O MR !3'), /aponta para "master".*Nada foi mesclado/);
    assert.throws(() => assertMergeTarget(refactor, 'hom', 'hom', 'O MR !3'));
    assert.throws(() => assertMergeTarget(free, 'develop', 'master', 'O PR #9'));
  });
});
