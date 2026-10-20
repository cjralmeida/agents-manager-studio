import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { phasesOfProfile } from './service.js';

describe('phasesOfProfile', () => {
  const profile = (name: string, instructions = '', output = 'PULL_REQUEST') => ({ name, instructions, output });

  it('takes the stage from the role skill the instructions mention', () => {
    assert.deepEqual(phasesOfProfile(profile('Construtor', 'Use a skill backend-builder para implementar.'), true), ['codificacao']);
    assert.deepEqual(phasesOfProfile(profile('hom-launcher', '', 'RESULT'), true), ['publicacao', 'codificacao']);
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
