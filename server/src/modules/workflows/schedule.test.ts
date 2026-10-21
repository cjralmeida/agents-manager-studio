import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dueSince } from './schedule.js';

describe('dueSince', () => {
  const weekly = { weekdays: [1], at: '08:00' };

  it('is due on the weekday once the local time has come, since that time', () => {
    // Monday 2026-10-26 09:30 in Brasília (12:30Z).
    assert.equal(dueSince(weekly, Date.parse('2026-10-26T12:30:15Z'))?.toISOString(), '2026-10-26T11:00:00.000Z');
  });

  it('is not due before the time or on another weekday', () => {
    assert.equal(dueSince(weekly, Date.parse('2026-10-26T10:59:00Z')), null);
    assert.equal(dueSince(weekly, Date.parse('2026-10-27T12:30:00Z')), null);
  });
});
