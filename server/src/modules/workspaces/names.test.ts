import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workspaceNameProblem } from './names.js';

describe('workspaceNameProblem', () => {
  it('accepts ordinary folder names', () => {
    assert.equal(workspaceNameProblem('Clientes 2027', ['pessoais']), null);
    assert.equal(workspaceNameProblem('GlobalFarm-Hub', []), null);
  });

  it('rejects names Windows or the Studio cannot use', () => {
    assert.match(workspaceNameProblem('  ', [])!, /Informe/);
    assert.match(workspaceNameProblem('a/b', [])!, /caracteres/);
    assert.match(workspaceNameProblem('nome:ruim', [])!, /caracteres/);
    assert.match(workspaceNameProblem('.oculto', [])!, /ponto/);
    assert.match(workspaceNameProblem('final.', [])!, /terminar/);
    assert.match(workspaceNameProblem('CON', [])!, /reservado/);
    assert.match(workspaceNameProblem('com1.txt', [])!, /reservado/);
    assert.match(workspaceNameProblem('Pessoais', ['pessoais'])!, /ignoradas/);
    assert.match(workspaceNameProblem('x'.repeat(81), [])!, /80/);
  });
});
