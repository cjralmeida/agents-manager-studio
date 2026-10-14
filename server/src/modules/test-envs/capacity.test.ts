import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exposedServices, reservationFits, stackMemoryMb } from './capacity.js';

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

describe('exposedServices and stackMemoryMb', () => {
  const services = {
    'db-test': { ports: [{ target: 5432 }] },
    'app-test': { build: { context: '.' }, ports: [{ target: 8080 }], mem_limit: '1073741824' },
  };

  it('reaches the built services that publish a port when nothing is labeled', () => {
    assert.deepEqual(exposedServices(services), [{ name: 'app-test', port: 8080 }]);
  });

  it('prefers the studio.test labels', () => {
    assert.deepEqual(exposedServices({ ...services, web: { labels: { 'studio.test': '80' } } }), [{ name: 'web', port: 80 }]);
  });

  it('counts mem_limit and a default for services without it', () => {
    assert.equal(stackMemoryMb(services), 1024 + 256);
    assert.equal(stackMemoryMb({ app: { labels: { 'studio.test.memory': '2048' } } }), 2048);
  });
});
