import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseClaudeResult } from './claude-result.js';

describe('parseClaudeResult', () => {
  it('finds the result line among other output', () => {
    const stdout = 'some warning\n{"type":"system"}\n{"type":"result","is_error":false,"result":"OK"}\n';
    assert.deepEqual(parseClaudeResult(stdout), { type: 'result', is_error: false, result: 'OK' });
  });

  it('keeps the api error status', () => {
    const stdout = '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate."}';
    assert.equal(parseClaudeResult(stdout)?.api_error_status, 401);
  });

  it('returns null without a result line', () => {
    assert.equal(parseClaudeResult('not json\n'), null);
  });
});
