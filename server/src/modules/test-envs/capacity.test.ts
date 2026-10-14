import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reservationFits } from './capacity.js';

const gb = 1024 ** 3;

describe('reservationFits', () => {
  it('fits while used memory plus reservations stay under the limit', () => {
    const base = { total: 32 * gb, limitPercent: 90, envMb: 1536 };
    assert.equal(reservationFits({ ...base, used: 20 * gb, reservedMb: 0, count: 1 }), true);
    assert.equal(reservationFits({ ...base, used: 20 * gb, reservedMb: 0, count: 5 }), true);
    assert.equal(reservationFits({ ...base, used: 20 * gb, reservedMb: 0, count: 6 }), false);
  });

  it('counts what environments still going up have reserved', () => {
    const base = { total: 32 * gb, limitPercent: 90, envMb: 1536, used: 26 * gb };
    assert.equal(reservationFits({ ...base, reservedMb: 0, count: 1 }), true);
    assert.equal(reservationFits({ ...base, reservedMb: 1536, count: 1 }), false);
  });

  it('never fits without knowing the memory', () => {
    assert.equal(reservationFits({ used: 0, total: 0, reservedMb: 0, limitPercent: 90, envMb: 1536, count: 1 }), false);
  });
});
