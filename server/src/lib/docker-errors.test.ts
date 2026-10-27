import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DockerError, isDockerTimeout, isRemovalInProgress } from './docker.js';

describe('Docker answers that are not failures of the work', () => {
  it('takes a removal already in progress as done', () => {
    assert.equal(isRemovalInProgress(new DockerError(409, 'removal of container 163e23a656c4 is already in progress')), true);
    assert.equal(isRemovalInProgress(new DockerError(409, 'conflict: unable to remove')), false);
    assert.equal(isRemovalInProgress(new DockerError(500, 'removal of container x is already in progress')), false);
  });

  it('tells a timeout from a refusal', () => {
    assert.equal(isDockerTimeout(new Error('Docker request timed out after 30000ms')), true);
    assert.equal(isDockerTimeout(new DockerError(409, 'conflict')), false);
  });
});
