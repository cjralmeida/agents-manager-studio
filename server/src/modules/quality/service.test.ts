import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lessonOrigin, phasesOfProfile, refRepository } from './service.js';

describe('phasesOfProfile', () => {
  const profile = (name: string, instructions = '', output = 'PULL_REQUEST') => ({ name, instructions, output });

  it('takes the stage from the role skill the instructions mention', () => {
    assert.deepEqual(phasesOfProfile(profile('Construtor', 'Use a skill backend-builder para implementar.'), true), ['codificacao']);
    assert.deepEqual(phasesOfProfile(profile('hom-launcher', '', 'RESULT'), true), ['publicacao', 'codificacao']);
    assert.deepEqual(phasesOfProfile(profile('frontend-guardian', 'Use a skill frontend-guardian.'), true), ['codificacao', 'testes']);
  });

  it('gives testers their own lessons first and the coding ones to check', () => {
    assert.deepEqual(phasesOfProfile(profile('hom-screen-ranger', 'Use a skill hom-screen-ranger.', 'RESULT'), false), ['testes', 'codificacao']);
  });

  it('does not match a skill inside another name', () => {
    assert.deepEqual(phasesOfProfile(profile('hom-api-ranger', 'Use a skill hom-api-ranger.', 'RESULT'), false), ['testes', 'codificacao']);
    assert.deepEqual(phasesOfProfile(profile('spec-architect (levantamento)'), true), ['especificacao']);
  });

  it('falls back to coding for an unknown agent that delivers code, and to nothing otherwise', () => {
    assert.deepEqual(phasesOfProfile(profile('Executor'), true), ['codificacao']);
    assert.deepEqual(phasesOfProfile(profile('Relator', '', 'RESULT'), true), []);
    assert.deepEqual(phasesOfProfile(null, false), []);
  });
});

describe('lessonOrigin', () => {
  const front = { name: 'gf-novo-oficial', others: ['globalfarm', 'gf-docs'] };

  it('reads the repository of full and short task references, not of free titles', () => {
    assert.equal(refRepository('realtec-vicosa/globalfarm/gf-novo-oficial#131'), 'gf-novo-oficial');
    assert.equal(refRepository('globalfarm#12'), 'globalfarm');
    assert.equal(refRepository('FUNC-011 API — funções e grupos de empresas'), null);
  });

  it('puts the lessons of the agent project first and those only seen in other projects last', () => {
    assert.equal(lessonOrigin(['realtec-vicosa/globalfarm/gf-novo-oficial#78', 'globalfarm#3'], front), 0);
    assert.equal(lessonOrigin(['FUNC-007 API — corrigir os rótulos'], front), 1);
    assert.equal(lessonOrigin(['realtec-vicosa/globalfarm/globalfarm#60', 'FUNC-009 API — corrigir a ordenação'], front), 2);
  });
});
