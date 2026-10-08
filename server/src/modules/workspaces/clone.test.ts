import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultFolder } from './clone.js';

describe('defaultFolder', () => {
  it('uses the repository name, like git clone', () => {
    assert.equal(defaultFolder('https://github.com/GlobalFarm-Hub/automacoes.git'), 'automacoes');
    assert.equal(defaultFolder('git@gitlab.com:realtec-vicosa/globalfarm/agro-gf.git'), 'agro-gf');
    assert.equal(defaultFolder('https://gitlab.com/realtec-vicosa/globalfarm/excel-gf'), 'excel-gf');
    assert.equal(defaultFolder('não é url'), '');
  });
});
