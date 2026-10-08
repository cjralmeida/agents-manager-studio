import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContainerStats } from '../../lib/docker.js';
import { cpuPercent, launchWarnings, memoryUsed } from './usage.js';

function stats(overrides: Partial<ContainerStats> = {}): ContainerStats {
  return {
    cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1_000 },
    memory_stats: { usage: 500, limit: 1_000, stats: { inactive_file: 100 } },
    ...overrides,
  };
}

describe('cpuPercent', () => {
  it('scales the container share of the system delta by the cpu count', () => {
    assert.equal(cpuPercent(stats()), 80);
  });

  it('is zero without a previous sample', () => {
    assert.equal(cpuPercent(stats({ precpu_stats: { cpu_usage: { total_usage: 0 } } })), 0);
  });
});

describe('memoryUsed', () => {
  it('discounts the page cache', () => {
    assert.equal(memoryUsed(stats()), 400);
    assert.equal(memoryUsed(stats({ memory_stats: { usage: 500, stats: { cache: 200 } } })), 300);
    assert.equal(memoryUsed(stats({ memory_stats: {} })), 0);
  });
});

describe('launchWarnings', () => {
  const limits = { memoryPercent: 80, cpuPercent: 85 };

  it('is empty below the limits', () => {
    assert.deepEqual(launchWarnings({ memoryPercent: 50, cpuPercent: 20 }, limits), []);
  });

  it('explains each exceeded limit', () => {
    assert.deepEqual(launchWarnings({ memoryPercent: 91.4, cpuPercent: 90 }, limits), [
      'Memória usada pelo Studio em 91% (limite 80%).',
      'CPU usada pelo Studio em 90% (limite 85%).',
    ]);
  });
});
