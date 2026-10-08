import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBoardUrl } from './board-url.js';

describe('parseBoardUrl', () => {
  it('parses GitHub organization and user projects', () => {
    assert.deepEqual(parseBoardUrl('https://github.com/orgs/GlobalFarm-Hub/projects/9'), {
      provider: 'GITHUB',
      host: 'github.com',
      ownerType: 'organization',
      owner: 'GlobalFarm-Hub',
      number: 9,
    });
    assert.deepEqual(parseBoardUrl('https://github.com/users/someone/projects/3/views/1?layout=board'), {
      provider: 'GITHUB',
      host: 'github.com',
      ownerType: 'user',
      owner: 'someone',
      number: 3,
    });
  });

  it('parses GitLab group boards with and without id', () => {
    assert.deepEqual(parseBoardUrl('https://gitlab.com/groups/realtec-vicosa/globalfarm/-/boards/123'), {
      provider: 'GITLAB',
      host: 'gitlab.com',
      groupPath: 'realtec-vicosa/globalfarm',
      boardId: 123,
    });
    assert.deepEqual(parseBoardUrl('https://gitlab.com/groups/realtec-vicosa/-/boards'), {
      provider: 'GITLAB',
      host: 'gitlab.com',
      groupPath: 'realtec-vicosa',
      boardId: null,
    });
  });

  it('rejects other urls', () => {
    assert.equal(parseBoardUrl('https://github.com/GlobalFarm-Hub/automacoes'), null);
    assert.equal(parseBoardUrl('not a url'), null);
  });
});
