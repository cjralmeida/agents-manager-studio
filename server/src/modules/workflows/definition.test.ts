import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ProfileFacts, type WorkflowStep, laneFor, stepSchema, validateSteps } from './definition.js';

const profiles: ProfileFacts[] = [
  { id: '01a11d00-0000-7000-8000-000000000001', name: 'Documentador', hasRepository: true, deliversCode: true, usesBoard: false },
  { id: '01a11d00-0000-7000-8000-000000000002', name: 'Planejador', hasRepository: false, deliversCode: false, usesBoard: true },
  { id: '01a11d00-0000-7000-8000-000000000003', name: 'Executor', hasRepository: true, deliversCode: true, usesBoard: false },
  { id: '01a11d00-0000-7000-8000-000000000004', name: 'Testador', hasRepository: true, deliversCode: false, usesBoard: false },
];

const agent = (id: string, profileIndex: number, extra: Partial<Extract<WorkflowStep, { kind: 'agent' }>> = {}) =>
  stepSchema.parse({ id, name: id, kind: 'agent', profileId: profiles[profileIndex]!.id, ...extra });
const deploy = (id: string) => stepSchema.parse({ id, name: id, kind: 'deploy' });

/** The flow the user described: doc → tasks → execute each → test each → deploy each. */
const fullFlow = [
  agent('doc', 0),
  agent('plan', 1),
  agent('exec', 2, { forEachTask: true }),
  agent('test', 3, { continueFromPrevious: true, onFailure: { retryStepId: 'exec', maxAttempts: 3 } }),
  deploy('deploy'),
];

describe('validateSteps', () => {
  it('accepts the documentation-to-deploy flow', () => {
    assert.deepEqual(validateSteps(fullFlow, profiles), []);
  });

  it('defaults the deploy to homologation', () => {
    assert.equal((fullFlow[4] as Extract<WorkflowStep, { kind: 'deploy' }>).environment, 'HOMOLOGACAO');
  });

  it('rejects broken chains', () => {
    assert.match(validateSteps([], profiles)[0]!, /ao menos um passo/);
    assert.match(validateSteps([deploy('d')], profiles)[0]!, /deploy precisa de um passo anterior/);
    assert.match(validateSteps([agent('a', 0), agent('b', 2, { forEachTask: true })], profiles)[0]!, /usa o quadro/);
    assert.match(validateSteps([agent('a', 1), agent('b', 3, { continueFromPrevious: true })], profiles)[0]!, /trabalhe em repositório/);
    assert.match(
      validateSteps([agent('a', 2), agent('b', 3, { onFailure: { retryStepId: 'b', maxAttempts: 2 } })], profiles)[0]!,
      /passo de agente anterior/,
    );
    assert.match(validateSteps([agent('a', 0), agent('a', 2)], profiles)[0]!, /ids diferentes/);
  });
});

describe('agents per step', () => {
  it('gives every step one agent unless it says how many', () => {
    assert.equal(agent('exec', 2).agents, 1);
    assert.equal(deploy('deploy').agents, 1);
    assert.equal(agent('exec', 2, { agents: 3 }).agents, 3);
    assert.throws(() => agent('exec', 2, { agents: 6 }));
  });
});

describe('laneFor', () => {
  it('runs steps before the fan-out once and the rest per task', () => {
    assert.equal(laneFor(fullFlow, 1, 'task-1'), 'main');
    assert.equal(laneFor(fullFlow, 2, 'task-1'), 'task-1');
    assert.equal(laneFor(fullFlow, 4, 'task-1'), 'task-1');
    assert.equal(laneFor([agent('a', 0)], 0, 'x'), 'main');
  });
});
