import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFinished, isSuccess, pullRequestNumber, statusLabel } from './status.js';

describe('deploy status', () => {
  it('knows when a deploy ended and whether it worked', () => {
    assert.equal(isFinished('build_in_progress'), false);
    assert.equal(isFinished('merging'), false);
    assert.equal(isFinished('live'), true);
    assert.equal(isSuccess('live'), true);
    assert.equal(isFinished('build_failed'), true);
    assert.equal(isSuccess('build_failed'), false);
    assert.equal(isFinished('error'), true);
    assert.equal(isSuccess('deactivated'), true);
  });

  it('labels statuses in Portuguese, keeping unknown ones', () => {
    assert.equal(statusLabel('live'), 'No ar');
    assert.equal(statusLabel('something_new'), 'something_new');
  });
});

describe('pullRequestNumber', () => {
  it('reads GitHub and GitLab urls', () => {
    assert.equal(pullRequestNumber('https://github.com/org/repo/pull/12'), 12);
    assert.equal(pullRequestNumber('https://gitlab.com/group/sub/repo/-/merge_requests/7'), 7);
    assert.equal(pullRequestNumber('https://gitlab.com/group/repo/-/merge_requests/7/diffs'), 7);
    assert.equal(pullRequestNumber('https://github.com/org/repo'), null);
  });
});
