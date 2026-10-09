import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repositorySlug } from './create-project.js';

describe('repositorySlug', () => {
  it('turns a folder name into a repository name', () => {
    assert.equal(repositorySlug('Meu Projeto'), 'Meu-Projeto');
    assert.equal(repositorySlug('Integração Áurea'), 'Integracao-Aurea');
    assert.equal(repositorySlug('api.v2_core'), 'api.v2_core');
    assert.equal(repositorySlug(' --x (beta)-- '), 'x-beta');
  });
});
