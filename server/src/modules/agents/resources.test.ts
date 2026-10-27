import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_SIZES, admission, agentSizeName, largerSize } from './resources.js';

const task = { kind: 'TASK', resourceSize: null };
const profile = (name: string, instructions = '') => ({ name, instructions });

describe('agentSizeName', () => {
  it('sizes by the role the profile names', () => {
    assert.equal(agentSizeName(task, profile('backend-builder', 'Use a skill backend-builder.')), 'G');
    assert.equal(agentSizeName(task, profile('Revisor', 'Use a skill code-guardian.')), 'G');
    assert.equal(agentSizeName(task, profile('frontend-guardian')), 'M');
    assert.equal(agentSizeName(task, profile('hom-screen-ranger')), 'M');
    assert.equal(agentSizeName(task, profile('spec-architect')), 'P');
    assert.equal(agentSizeName(task, profile('hom-launcher')), 'P');
  });

  it('does not mistake a longer skill name for a role', () => {
    assert.equal(agentSizeName(task, profile('hom-ranger-x')), 'P');
  });

  it('keeps Órbi small, an agent without profile medium and an OOM bump as set', () => {
    assert.equal(agentSizeName({ kind: 'ASSISTANT', resourceSize: null }, null), 'P');
    assert.equal(agentSizeName(task, null), 'M');
    assert.equal(agentSizeName({ kind: 'TASK', resourceSize: 'GG' }, profile('spec-architect')), 'GG');
  });
});

describe('largerSize', () => {
  it('goes one size up and stops at the largest', () => {
    assert.equal(largerSize('M'), 'G');
    assert.equal(largerSize('GG'), null);
  });
});

describe('admission', () => {
  const budget = { cpus: 15, memoryMb: 12_800 };

  it('admits while reserved memory and CPU fit the budget', () => {
    assert.equal(admission([AGENT_SIZES.G, AGENT_SIZES.M, AGENT_SIZES.P], AGENT_SIZES.G, budget), null);
  });

  it('holds when memory would go past the budget', () => {
    const reason = admission(Array<typeof AGENT_SIZES.G>(5).fill(AGENT_SIZES.G), AGENT_SIZES.M, budget);
    assert.match(reason ?? '', /memória reservada 12\.5\/12\.5 GB/);
  });

  it('holds when CPU would go past the budget', () => {
    const reason = admission(Array<typeof AGENT_SIZES.P>(7).fill(AGENT_SIZES.P).concat([AGENT_SIZES.M, AGENT_SIZES.M, AGENT_SIZES.M]), AGENT_SIZES.G, { ...budget, memoryMb: 64_000 });
    assert.match(reason ?? '', /CPU reservada 13\/15 vCPU/);
  });
});
