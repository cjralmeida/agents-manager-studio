import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stuckReason, type RunSummary } from './rules.js';

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1',
  workflowId: 'w1',
  workflowName: 'Backend até homologação',
  workflowEnabled: true,
  boardTriggered: true,
  status: 'FAILED',
  error: "git clone failed: Cloning into '/data/agents/x'...",
  runsLastDay: 1,
  ...overrides,
});

describe('stuckReason', () => {
  it('runs the workflow again when the last run failed for a passing reason', () => {
    assert.equal(stuckReason('Em validação', run(), 2).retriable, true);
    assert.equal(stuckReason('Em validação', run({ error: "You've hit your session limit · resets 3:20pm" }), 2).retriable, true);
  });

  it('asks for help when the failure is about the work, the workflow is off or it was retried enough', () => {
    assert.equal(stuckReason('Em validação', run({ error: 'Reprovado — 4 bloqueios' }), 2).retriable, false);
    assert.equal(stuckReason('Em validação', run({ workflowEnabled: false }), 2).retriable, false);
    assert.equal(stuckReason('Em validação', run({ runsLastDay: 3 }), 2).retriable, false);
    assert.equal(stuckReason('Em validação', run({ error: 'O PR/MR não pôde ser mesclado ("405 Method Not Allowed")' }), 2).retriable, false);
  });

  it('explains a task no workflow took and a run that ended without moving it', () => {
    assert.match(stuckReason('Em andamento', null, 2).reason, /Nenhum workflow pegou/);
    assert.match(stuckReason('Em homologação', run({ status: 'COMPLETED' }), 2).reason, /terminou, mas a tarefa ficou em "Em homologação"/);
  });
});
