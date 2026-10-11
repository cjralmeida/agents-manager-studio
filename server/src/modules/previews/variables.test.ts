import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectVariableKeyError, renderDotenv } from './variables.js';

describe('projectVariableKeyError', () => {
  it('accepts usual names and refuses invalid or reserved ones', () => {
    assert.equal(projectVariableKeyError('DATABASE_URL'), null);
    assert.equal(projectVariableKeyError('VITE_API_URL'), null);
    assert.match(projectVariableKeyError('1ABC') ?? '', /letras/);
    assert.match(projectVariableKeyError('PATH') ?? '', /container/);
  });
});

describe('renderDotenv', () => {
  it('keeps plain values literal in single quotes, $ included', () => {
    assert.equal(renderDotenv({ A: 'x$y', B: 'senha com espaço' }), "A='x$y'\nB='senha com espaço'\n");
  });

  it('doubles $ inside double quotes, so compose keeps it literal', () => {
    assert.equal(renderDotenv({ A: "it's $x" }), `A="it's $$x"\n`);
  });

  it('escapes values with quotes or line breaks in double quotes', () => {
    assert.equal(renderDotenv({ A: "it's", B: 'a\nb' }), 'A="it\'s"\nB="a\\nb"\n');
  });
});
