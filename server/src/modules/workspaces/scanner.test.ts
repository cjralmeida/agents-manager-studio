import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { detectProvider, parseOriginUrl, scanProjectsRoot, stripCredentials } from './scanner.js';

describe('parseOriginUrl', () => {
  it('reads the origin url and ignores other remotes', () => {
    const gitConfig = [
      '[core]',
      '\tbare = false',
      '[remote "upstream"]',
      '\turl = https://github.com/other/repo.git',
      '[remote "origin"]',
      '\turl = git@gitlab.com:team/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');
    assert.equal(parseOriginUrl(gitConfig), 'git@gitlab.com:team/repo.git');
  });

  it('returns null without an origin remote', () => {
    assert.equal(parseOriginUrl('[core]\n\tbare = false\n'), null);
  });
});

describe('stripCredentials', () => {
  it('removes user and token from https urls', () => {
    assert.equal(stripCredentials('https://user:secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  });

  it('keeps ssh urls untouched', () => {
    assert.equal(stripCredentials('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  });
});

describe('detectProvider', () => {
  it('detects providers from https, ssh and scp-like urls', () => {
    assert.equal(detectProvider('https://github.com/a/b.git'), 'GITHUB');
    assert.equal(detectProvider('git@gitlab.com:a/b.git'), 'GITLAB');
    assert.equal(detectProvider('ssh://git@gitlab.company.com/a/b.git'), 'GITLAB');
    assert.equal(detectProvider('https://bitbucket.org/a/b.git'), 'OTHER');
  });
});

describe('scanProjectsRoot', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'scan-'));
    await mkdir(path.join(root, 'Acme', 'api', '.git'), { recursive: true });
    await writeFile(
      path.join(root, 'Acme', 'api', '.git', 'config'),
      '[remote "origin"]\n\turl = https://token@github.com/acme/api.git\n',
    );
    await mkdir(path.join(root, 'Acme', 'notes'), { recursive: true });
    await mkdir(path.join(root, 'Acme', '.cache'), { recursive: true });
    await mkdir(path.join(root, 'Pessoais', 'game'), { recursive: true });
    await writeFile(path.join(root, 'readme.txt'), 'not a folder');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('maps folders to workspaces and projects, skipping excluded and hidden folders', async () => {
    const result = await scanProjectsRoot(root, ['pessoais']);

    assert.deepEqual(result, [
      {
        name: 'Acme',
        projects: [
          {
            name: 'api',
            isGitRepo: true,
            gitRemoteUrl: 'https://github.com/acme/api.git',
            gitProvider: 'GITHUB',
          },
          { name: 'notes', isGitRepo: false, gitRemoteUrl: null, gitProvider: null },
        ],
      },
    ]);
  });
});
