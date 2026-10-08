import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ModelTotals, mergeTotals, normalizePlanUsage, usageDeltas } from './calc.js';

const totals = (input: number, output: number, cost: number): ModelTotals => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: cost,
});

describe('usageDeltas', () => {
  it('counts a first report entirely', () => {
    assert.deepEqual(usageDeltas({}, { haiku: totals(100, 10, 0.5) }), [
      { model: 'haiku', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 },
    ]);
  });

  it('subtracts the previous running total', () => {
    const [delta] = usageDeltas({ haiku: totals(100, 10, 0.5) }, { haiku: totals(150, 30, 0.75) });
    assert.equal(delta?.inputTokens, 50);
    assert.equal(delta?.outputTokens, 20);
    assert.equal(delta?.costUsd, 0.25);
  });

  it('starts over when a total goes down (new session)', () => {
    const [delta] = usageDeltas({ haiku: totals(100, 10, 0.5) }, { haiku: totals(40, 5, 0.1) });
    assert.equal(delta?.inputTokens, 40);
  });

  it('ignores models without changes', () => {
    assert.deepEqual(usageDeltas({ haiku: totals(1, 1, 1) }, { haiku: totals(1, 1, 1) }), []);
  });
});

describe('mergeTotals', () => {
  it('keeps other models and replaces reported ones', () => {
    const merged = mergeTotals({ opus: totals(1, 1, 1), haiku: totals(1, 1, 1) }, { haiku: totals(5, 5, 5) });
    assert.deepEqual(Object.keys(merged).sort(), ['haiku', 'opus']);
    assert.equal(merged.haiku?.inputTokens, 5);
  });
});

describe('normalizePlanUsage', () => {
  it('reads the unified 5-hour and weekly windows as percentages', () => {
    const usage = normalizePlanUsage({
      status: 'allowed',
      unifiedWindows: {
        seven_day: { utilization: 0.19, resetsAt: 1791810000 },
        five_hour: { utilization: 0.26, resetsAt: 1791491400 },
      },
    });
    assert.equal(usage.status, 'allowed');
    assert.deepEqual(
      usage.windows.map((window) => [window.key, window.percent]),
      [
        ['five_hour', 26],
        ['seven_day', 19],
      ],
    );
    assert.equal(usage.windows[0]?.resetsAt, new Date(1791491400 * 1000).toISOString());
  });

  it('falls back to the window that triggered the event', () => {
    const usage = normalizePlanUsage({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1791491400 });
    assert.deepEqual(usage.windows.map((window) => window.percent), [50]);
  });
});
