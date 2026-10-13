import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyExpired } from './cleanup-policy.js';

const now = new Date('2026-10-13T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const retention = { completedHours: 24, failedDays: 7, diskShort: false };
const agent = (status: string, hours: number, runStatus: string | null = null) => ({ status, finishedAt: hoursAgo(hours), lastActivityAt: hoursAgo(hours), runStatus });

describe('copyExpired', () => {
  it('keeps completed copies for a day and failed or cancelled ones for a week', () => {
    assert.equal(copyExpired(agent('COMPLETED', 23), now, retention), false);
    assert.equal(copyExpired(agent('COMPLETED', 25), now, retention), true);
    assert.equal(copyExpired(agent('FAILED', 25), now, retention), false);
    assert.equal(copyExpired(agent('CANCELLED', 24 * 8), now, retention), true);
  });

  it('never deletes copies of active agents or of a workflow run still going', () => {
    assert.equal(copyExpired(agent('READY_FOR_REVIEW', 500), now, retention), false);
    assert.equal(copyExpired(agent('COMPLETED', 500, 'RUNNING'), now, retention), false);
  });

  it('frees every finished copy at once when the disk is short', () => {
    const short = { ...retention, diskShort: true };
    assert.equal(copyExpired(agent('COMPLETED', 1), now, short), true);
    assert.equal(copyExpired(agent('COMPLETED', 1, 'RUNNING'), now, short), false);
  });
});
