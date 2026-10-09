import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownerLookupFor } from './ownership.js';

describe('ownerLookupFor', () => {
  it('finds the rule of routes under an owned entity', () => {
    for (const url of ['/api/workspaces/:id', '/api/workspaces/:id/board/items/:itemId/move', '/api/agents/:id/events', '/api/git-accounts/:id/verify', '/api/workflow-runs/:id/cancel']) {
      assert.notEqual(ownerLookupFor(url), null, url);
    }
  });

  it('leaves alone routes without an owned id', () => {
    for (const url of ['/api/workspaces', '/api/workspaces/scan', '/api/users/:id', '/api/auth/me', '/api/agents', '/api/board-model']) {
      assert.equal(ownerLookupFor(url), null, url);
    }
  });

  it('does not confuse similar prefixes', () => {
    assert.equal(ownerLookupFor('/api/workflows-x/:id'), null);
    assert.notEqual(ownerLookupFor('/api/workflows/:id/start'), null);
  });
});
