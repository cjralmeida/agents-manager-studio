import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlanLimitError, limitResumeAt, planBlockedUntil } from './limit.js';

const now = new Date('2026-10-12T22:00:00Z');
const window = (key: string, percent: number, resetsAt: string) => ({ key, label: key, percent, resetsAt });

describe('plan limit', () => {
  it('recognizes the limit messages of Claude Code', () => {
    assert.ok(isPlanLimitError('Claude AI usage limit reached|1791860000'));
    assert.ok(isPlanLimitError("You've hit your limit · resets 3am (America/Sao_Paulo)"));
    assert.ok(isPlanLimitError("You've hit your session limit · resets 3:20pm (UTC)"));
    assert.ok(isPlanLimitError('5-hour limit reached ∙ resets 3am'));
    assert.ok(!isPlanLimitError('npm test failed'));
  });

  it('resumes after the reset in the message, else the full window of the plan, else in 30 minutes', () => {
    assert.equal(limitResumeAt('usage limit reached|1791860000', null, now).toISOString(), new Date(1791860000 * 1000 + 120_000).toISOString());
    const plan = { status: 'rejected', windows: [window('five_hour', 100, '2026-10-13T01:00:00Z'), window('seven_day', 40, '2026-10-16T00:00:00Z')] };
    assert.equal(limitResumeAt('limit reached', plan, now).toISOString(), '2026-10-13T01:02:00.000Z');
    const weekly = { status: 'rejected', windows: [window('five_hour', 30, '2026-10-13T01:00:00Z'), window('seven_day', 100, '2026-10-16T00:00:00Z')] };
    assert.equal(limitResumeAt('limit reached', weekly, now).toISOString(), '2026-10-16T00:02:00.000Z');
    assert.equal(limitResumeAt('limit reached', null, now).toISOString(), '2026-10-12T22:30:00.000Z');
  });

  it('a rejected plan stops blocking once its reset has passed', () => {
    const plan = { status: 'rejected', windows: [window('five_hour', 100, '2026-10-13T01:00:00Z')] };
    assert.ok(planBlockedUntil(plan, now));
    assert.equal(planBlockedUntil(plan, new Date('2026-10-13T01:05:00Z')), null);
    assert.equal(planBlockedUntil({ status: 'allowed', windows: [window('five_hour', 50, '2026-10-13T01:00:00Z')] }, now), null);
  });
});
