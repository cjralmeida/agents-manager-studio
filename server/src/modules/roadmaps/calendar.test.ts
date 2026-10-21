import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_DAY, BUSINESS_HOURS, addWorkingMs, idleGaps, localDay, workingMs } from './calendar.js';

const HOUR = 3_600_000;
const business = { timeZone: 'America/Sao_Paulo', ...BUSINESS_HOURS };
const allDay = { timeZone: 'America/Sao_Paulo', ...ALL_DAY };
const at = (iso: string) => Date.parse(iso);

describe('working calendar', () => {
  it('counts only weekdays from 7h to 17h in the time zone', () => {
    // Friday 2026-10-23 12:00 local (15:00Z) to Monday 2026-10-26 09:00 local (12:00Z): 5 h on Friday + 2 h on Monday.
    assert.equal(workingMs(business, at('2026-10-23T15:00:00Z'), at('2026-10-26T12:00:00Z')), 7 * HOUR);
  });

  it('counts every hour round the clock', () => {
    assert.equal(workingMs(allDay, at('2026-10-23T15:00:00Z'), at('2026-10-26T12:00:00Z')), 69 * HOUR);
  });

  it('takes the pauses out', () => {
    const pause = { from: at('2026-10-23T16:00:00Z'), to: at('2026-10-23T18:00:00Z') };
    assert.equal(workingMs(business, at('2026-10-23T15:00:00Z'), at('2026-10-23T20:00:00Z'), [pause]), 3 * HOUR);
  });

  it('walks working time forward over the weekend', () => {
    // 6 working hours from Friday 15:00 local: 2 h on Friday, 4 h on Monday (7h to 11h local = 14:00Z).
    assert.equal(addWorkingMs(business, at('2026-10-23T18:00:00Z'), 6 * HOUR), at('2026-10-26T14:00:00Z'));
  });

  it('reads the local day', () => {
    assert.equal(localDay('America/Sao_Paulo', at('2026-10-24T02:00:00Z')), '2026-10-23');
  });
});

describe('idleGaps', () => {
  it('finds working stretches with nothing running, longer than the threshold', () => {
    const activity = [
      { from: at('2026-10-20T00:00:00Z'), to: at('2026-10-20T10:00:00Z') },
      { from: at('2026-10-20T11:00:00Z'), to: at('2026-10-20T12:00:00Z') },
      { from: at('2026-10-21T12:00:00Z'), to: at('2026-10-21T13:00:00Z') },
    ];
    const gaps = idleGaps(allDay, activity, at('2026-10-20T00:00:00Z'), at('2026-10-21T13:00:00Z'), 3 * HOUR);
    assert.deepEqual(gaps, [{ from: at('2026-10-20T12:00:00Z'), to: at('2026-10-21T12:00:00Z') }]);
  });

  it('joins idle time split only by nights and weekends', () => {
    // Nothing from Friday 16h local to Monday 9h local: 1 h + 2 h of working time, one gap of 3 h.
    const activity = [
      { from: at('2026-10-23T10:00:00Z'), to: at('2026-10-23T19:00:00Z') },
      { from: at('2026-10-26T12:00:00Z'), to: at('2026-10-26T15:00:00Z') },
    ];
    const gaps = idleGaps(business, activity, at('2026-10-23T10:00:00Z'), at('2026-10-26T15:00:00Z'), 3 * HOUR);
    assert.deepEqual(gaps, [{ from: at('2026-10-23T19:00:00Z'), to: at('2026-10-26T12:00:00Z') }]);
  });
});
