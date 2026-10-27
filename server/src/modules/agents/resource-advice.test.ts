import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Measured, percentile, roleSuggestion, settingsProblem, sizeSuggestions, usageStats } from './resource-advice.js';
import { AGENT_SIZES, mergeSettings } from './resources.js';

const agent = (peakMemoryMb: number, avgCpu = 50, resourceSize: string | null = null): Measured => ({
  sizeName: 'M',
  resourceSize,
  peakMemoryMb,
  peakCpuPercent: avgCpu * 2,
  cpuPercentSum: avgCpu * 10,
  usageSamples: 10,
});

describe('percentile', () => {
  it('takes the value 90% of the samples stay under', () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([], 90), 0);
  });
});

describe('sizeSuggestions', () => {
  it('moves the reservation to the usual peak plus 10%', () => {
    const stats = usageStats([600, 700, 800, 900, 1000].map((mb) => agent(mb)));
    const [reserve] = sizeSuggestions('M', AGENT_SIZES.M, stats);
    assert.deepEqual(reserve && { kind: reserve.kind, from: reserve.from, to: reserve.to }, { kind: 'reserve', from: 1536, to: 1280 });
  });

  it('raises the limit after an OOM or a peak near it', () => {
    const stats = usageStats([1000, 1100, 1200, 1300, 2900].map((mb) => agent(mb)));
    assert.ok(sizeSuggestions('M', AGENT_SIZES.M, stats).some((item) => item.kind === 'memory' && item.to === 4096));
  });

  it('says nothing with too few agents', () => {
    assert.deepEqual(sizeSuggestions('M', AGENT_SIZES.M, usageStats([agent(100)])), []);
  });
});

describe('roleSuggestion', () => {
  it('moves a role that runs out of memory one size up, never to GG', () => {
    assert.equal(roleSuggestion('M', AGENT_SIZES, usageStats([agent(900), agent(1000), agent(1100, 50, 'G')])), 'G');
    assert.equal(roleSuggestion('G', AGENT_SIZES, usageStats([agent(4500), agent(4600), agent(4700)])), null);
  });

  it('moves a light role one size down', () => {
    assert.equal(roleSuggestion('M', AGENT_SIZES, usageStats([agent(200, 10), agent(300, 10), agent(400, 10)])), 'P');
    assert.equal(roleSuggestion('M', AGENT_SIZES, usageStats([agent(200, 80), agent(300, 80), agent(400, 80)])), null);
  });
});

describe('settingsProblem', () => {
  it('refuses a reservation over the limit and sizes out of order', () => {
    const settings = mergeSettings(null);
    assert.equal(settingsProblem(settings), null);
    assert.match(settingsProblem({ ...settings, sizes: { ...settings.sizes, P: { ...settings.sizes.P, reserveMb: 4096 } } }) ?? '', /reserva/);
    assert.match(settingsProblem({ ...settings, sizes: { ...settings.sizes, M: { ...settings.sizes.M, memoryMb: 1024, reserveMb: 512 } } }) ?? '', /menor/);
  });
});
