import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type StepLoad, capacitySignals, signalsSignature } from './signals.js';

const step = (overrides: Partial<StepLoad> = {}): StepLoad => ({
  workflowId: 'wf',
  workflowName: 'Backend',
  stepId: 'builder',
  stepName: 'Implementar',
  index: 0,
  agents: 1,
  active: 1,
  queued: 0,
  ready: [],
  single: false,
  idleMinutes: 5,
  recentConflicts: 0,
  ...overrides,
});
const review = (overrides: Partial<StepLoad> = {}) => step({ stepId: 'guardian', stepName: 'Revisar', index: 1, ...overrides });
const plan = (sessionPercent: number | null, weekPercent: number | null = 10) => ({ sessionPercent, weekPercent, limitPercent: 98 });
const task = (ref: string) => ({ ref, title: ref });

describe('capacitySignals per step', () => {
  it('adds an agent to a busy first step with ready tasks', () => {
    const [signal] = capacitySignals([step({ ready: [task('r#1')] })], plan(40));
    assert.equal(signal?.stepId, 'builder');
    assert.equal(signal?.direction, 'up');
    assert.equal(signal?.to, 2);
  });

  it('does not feed the line when a later step is backed up; the later step gets the agent instead', () => {
    const signals = capacitySignals([step({ ready: [task('r#1')] }), review({ queued: 3 })], plan(40));
    assert.deepEqual(
      signals.map((signal) => `${signal.stepId}:${signal.direction}`),
      ['guardian:up'],
    );
  });

  it('never adds agents to a single-resource step (one homologation)', () => {
    assert.deepEqual(capacitySignals([review({ stepId: 'launcher', queued: 4, single: true })], plan(10)), []);
  });

  it('stays quiet with a free agent, nothing ready, or the plan without room', () => {
    assert.deepEqual(capacitySignals([step({ active: 0, ready: [task('r#1')] })], plan(40)), []);
    assert.deepEqual(capacitySignals([step()], plan(40)), []);
    assert.deepEqual(capacitySignals([step({ ready: [task('r#1')] })], plan(80)), []);
    assert.deepEqual(capacitySignals([step({ ready: [task('r#1')] })], plan(40, 95)), []);
  });

  it('takes an agent away near the plan limit, after merge conflicts, or when a step sits idle', () => {
    assert.equal(capacitySignals([step({ agents: 3 })], plan(90))[0]?.to, 2);
    assert.match(capacitySignals([step({ agents: 2, recentConflicts: 1 })], plan(10))[0]?.reason ?? '', /conflito/);
    const idle = capacitySignals([review({ agents: 2, active: 0, idleMinutes: 90 })], plan(10));
    assert.equal(idle[0]?.direction, 'down');
    assert.deepEqual(capacitySignals([review({ agents: 2, active: 0, idleMinutes: 20 })], plan(10)), []);
  });

  it('keeps an idle step whose work is on its way: an earlier step working, or tasks waiting for dependencies', () => {
    const builderWorking = step({ agents: 1, active: 1 });
    assert.deepEqual(capacitySignals([builderWorking, review({ agents: 2, active: 0, idleMinutes: 90 })], plan(10)), []);
    const lotsWaiting = step({ agents: 4, active: 0, idleMinutes: 90, upcoming: 11 });
    assert.deepEqual(capacitySignals([lotsWaiting, review({ agents: 2, active: 0, idleMinutes: 90 })], plan(10)), []);
    const nothingComing = step({ agents: 4, active: 0, idleMinutes: 90, upcoming: 0 });
    assert.equal(capacitySignals([nothingComing], plan(10))[0]?.direction, 'down');
  });

  it('never goes above five or below one', () => {
    assert.deepEqual(capacitySignals([step({ agents: 5, active: 5, ready: [task('a')] })], plan(10)), []);
    assert.deepEqual(capacitySignals([step({ agents: 1, recentConflicts: 2 })], plan(95)), []);
  });
});

describe('capacitySignals with the computer', () => {
  const machine = (memoryPercent: number, cpuPercent: number, freeDiskGb: number | null = 50) => ({
    memoryPercent,
    cpuPercent,
    freeDiskGb,
    memoryLimit: 80,
    cpuLimit: 85,
    minFreeDiskGb: 10,
    source: 'host' as const,
  });

  it('does not add agents when the computer has no room', () => {
    const busy = [step({ ready: [task('r#1')] })];
    assert.deepEqual(capacitySignals(busy, plan(10), machine(75, 30)), []);
    assert.deepEqual(capacitySignals(busy, plan(10), machine(40, 90)), []);
    assert.equal(capacitySignals(busy, plan(10), machine(40, 30))[0]?.direction, 'up');
  });

  it('takes an agent away when memory or the disk are at the limit, not for a CPU spike', () => {
    const [memory] = capacitySignals([step({ agents: 3 })], plan(10), machine(88, 30));
    assert.equal(memory?.direction, 'down');
    assert.match(memory?.reason ?? '', /memória do computador em 88%/);
    assert.match(capacitySignals([step({ agents: 2 })], plan(10), machine(40, 30, 4))[0]?.reason ?? '', /disco/);
    assert.deepEqual(capacitySignals([step({ agents: 3 })], plan(10), machine(40, 100)), []);
  });
});

describe('signalsSignature', () => {
  it('changes when other tasks become ready, not with the order', () => {
    const steps = [step({ ready: [task('r#1'), task('r#2')] })];
    const signals = capacitySignals(steps, plan(10));
    const reversed = [step({ ready: [task('r#2'), task('r#1')] })];
    assert.equal(signalsSignature(signals, steps), signalsSignature(signals, reversed));
    const other = [step({ ready: [task('r#3')] })];
    assert.notEqual(signalsSignature(signals, steps), signalsSignature(capacitySignals(other, plan(10)), other));
  });
});
