import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkExcludeNames, checkProjectsDir, manualCommand, sameFolder } from './projects-root.js';

describe('checkProjectsDir', () => {
  it('normalizes backslashes and trailing slashes', () => {
    assert.deepEqual(checkProjectsDir(' E:\\Trabalho\\Projetos\\ '), { path: 'E:/Trabalho/Projetos', problem: null });
  });

  it('refuses relative paths, drive roots and system folders', () => {
    for (const input of ['Projetos', '/data/x', 'D:/', 'D:', 'C:\\Windows\\Temp', 'c:/Program Files', 'C:/Users', 'C:/Users/celso']) {
      assert.notEqual(checkProjectsDir(input).problem, null, input);
    }
    assert.equal(checkProjectsDir('C:/Users/celso/Projetos').problem, null);
  });

  it('refuses characters that would break the command', () => {
    for (const input of ["D:/a'b", 'D:/a;b', 'D:/$env', 'D:/a`b', 'D:/a"b']) assert.notEqual(checkProjectsDir(input).problem, null, input);
  });
});

describe('checkExcludeNames', () => {
  it('trims, drops empty and repeated names', () => {
    assert.deepEqual(checkExcludeNames([' Pessoais ', '', 'Pessoais', 'Arquivo']), { names: ['Pessoais', 'Arquivo'], problem: null });
  });

  it('refuses paths and unsafe characters', () => {
    assert.notEqual(checkExcludeNames(['a/b']).problem, null);
    assert.notEqual(checkExcludeNames(["it's"]).problem, null);
  });
});

describe('sameFolder', () => {
  it('ignores case and slash direction', () => {
    assert.equal(sameFolder('D:/Projetos', 'd:\\projetos\\'), true);
    assert.equal(sameFolder('D:/Projetos', 'D:/Projetos2'), false);
  });
});

describe('manualCommand', () => {
  it('points at the Studio script with the chosen folder', () => {
    assert.equal(
      manualCommand({ studioDir: 'D:\\Studio', dev: true, path: 'E:/Projetos', exclude: ['Pessoais', 'Velhos'] }),
      "powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\\Studio\\studio.ps1' -ProjectsDir 'E:/Projetos' -Exclude 'Pessoais,Velhos' -Dev",
    );
    assert.match(manualCommand({ studioDir: null, dev: false, path: 'E:/P', exclude: [] }), /-File \.\\studio\.ps1 -ProjectsDir 'E:\/P' -NoExclude$/);
  });
});
