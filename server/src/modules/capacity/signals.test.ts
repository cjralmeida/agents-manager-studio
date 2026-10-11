import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type WorkflowLoad, capacitySignals, signalsSignature } from './signals.js';

const load = (overrides: Partial<WorkflowLoad> = {}): WorkflowLoad => ({
  workflowId: 'wf',
  workflowName: 'Engine',
  max: 1,
  running: 1,
  ready: [],
  waiting: 0,
  recentConflicts: 0,
  ...overrides,
});
const plan = (sessionPercent: number | null, weekPercent: number | null = 10) => ({ sessionPercent, weekPercent, limitPercent: 98 });
const task = (ref: string) => ({ ref, title: ref });

describe('capacitySignals', () => {
  it('suggests more runs when every slot is busy and tasks are ready', () => {
    const [signal] = capacitySignals([load({ ready: [task('r#1')] })], plan(40));
    assert.equal(signal?.direction, 'up');
    assert.equal(signal?.to, 2);
  });

  it('stays quiet with a free slot, nothing ready, or the plan without room', () => {
    assert.deepEqual(capacitySignals([load({ running: 0, ready: [task('r#1')] })], plan(40)), []);
    assert.deepEqual(capacitySignals([load()], plan(40)), []);
    assert.deepEqual(capacitySignals([load({ ready: [task('r#1')] })], plan(80)), []);
    assert.deepEqual(capacitySignals([load({ ready: [task('r#1')] })], plan(40, 95)), []);
  });

  it('suggests fewer runs near the plan limit or after merge conflicts', () => {
    assert.equal(capacitySignals([load({ max: 3 })], plan(90))[0]?.to, 1);
    const [conflict] = capacitySignals([load({ max: 3, recentConflicts: 1 })], plan(10));
    assert.equal(conflict?.direction, 'down');
    assert.equal(conflict?.to, 2);
  });

  it('never goes above five or below one', () => {
    assert.equal(capacitySignals([load({ max: 4, running: 4, ready: [task('a'), task('b'), task('c')] })], plan(10))[0]?.to, 5);
    assert.deepEqual(capacitySignals([load({ max: 5, running: 5, ready: [task('a')] })], plan(10)), []);
    assert.deepEqual(capacitySignals([load({ max: 1, recentConflicts: 2 })], plan(95)), []);
  });
});

describe('signalsSignature', () => {
  it('changes when other tasks become ready, not with the order', () => {
    const loads = [load({ ready: [task('r#1'), task('r#2')] })];
    const signals = capacitySignals(loads, plan(10));
    const reversed = [load({ ready: [task('r#2'), task('r#1')] })];
    assert.equal(signalsSignature(signals, loads), signalsSignature(signals, reversed));
    const other = [load({ ready: [task('r#3')] })];
    assert.notEqual(signalsSignature(signals, loads), signalsSignature(capacitySignals(other, plan(10)), other));
  });
});
