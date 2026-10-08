import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authenticatedPushUrl, parseRemote, remoteHostname } from './remote.js';

describe('parseRemote', () => {
  it('parses https remotes with and without .git', () => {
    assert.deepEqual(parseRemote('https://github.com/trianglo-tech/vertex.git'), {
      host: 'github.com',
      path: 'trianglo-tech/vertex',
    });
    assert.deepEqual(parseRemote('https://gitlab.com/realtec-vicosa/globalfarm/excel-gf'), {
      host: 'gitlab.com',
      path: 'realtec-vicosa/globalfarm/excel-gf',
    });
  });

  it('parses scp-like ssh remotes with nested groups', () => {
    assert.deepEqual(parseRemote('git@gitlab.com:realtec-vicosa/globalfarm/gf-syncer.git'), {
      host: 'gitlab.com',
      path: 'realtec-vicosa/globalfarm/gf-syncer',
    });
  });

  it('drops ssh ports but keeps https ports', () => {
    assert.deepEqual(parseRemote('ssh://git@git.company.com:2222/team/app.git'), {
      host: 'git.company.com',
      path: 'team/app',
    });
    assert.deepEqual(parseRemote('https://git.company.com:8443/team/app.git'), {
      host: 'git.company.com:8443',
      path: 'team/app',
    });
  });

  it('returns null for local paths', () => {
    assert.equal(parseRemote('/srv/repos/app'), null);
  });
});

describe('remoteHostname', () => {
  it('removes the port', () => {
    assert.equal(remoteHostname({ host: 'git.company.com:8443', path: 'a/b' }), 'git.company.com');
  });
});

describe('authenticatedPushUrl', () => {
  it('uses the provider token user and encodes the token', () => {
    const remote = { host: 'gitlab.com', path: 'group/repo' };
    assert.equal(authenticatedPushUrl(remote, 'GITLAB', 'glpat-a/b'), 'https://oauth2:glpat-a%2Fb@gitlab.com/group/repo.git');
    assert.equal(
      authenticatedPushUrl({ host: 'github.com', path: 'o/r' }, 'GITHUB', 'ghp_x'),
      'https://x-access-token:ghp_x@github.com/o/r.git',
    );
  });
});
