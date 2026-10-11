import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidatePorts, daemonPath, pickService } from './runners.js';

describe('daemonPath', () => {
  it('turns a Windows drive path into the Docker Desktop path', () => {
    assert.equal(daemonPath('D:/AgentsWorktrees/previews/x/src'), '/run/desktop/mnt/host/d/AgentsWorktrees/previews/x/src');
    assert.equal(daemonPath('C:\\dados\\app'), '/run/desktop/mnt/host/c/dados/app');
  });

  it('keeps Linux paths', () => {
    assert.equal(daemonPath('/srv/agents/previews'), '/srv/agents/previews');
  });
});

describe('pickService', () => {
  it('prefers the service labeled studio.rodar, with the port in the label', () => {
    const services = {
      db: { ports: [{ target: 5432 }] },
      web: { labels: { 'studio.rodar': '8080' }, expose: ['3000'] },
    };
    assert.deepEqual(pickService(services), { service: 'web', port: 8080 });
  });

  it('otherwise takes the first service that publishes or exposes a port', () => {
    assert.deepEqual(pickService({ worker: {}, api: { ports: [{ target: 3000 }] } }), { service: 'api', port: 3000 });
    assert.deepEqual(pickService({ worker: {}, app: { expose: ['8000/tcp'] } }), { service: 'app', port: 8000 });
  });

  it('is null when no service has a port', () => {
    assert.equal(pickService({ worker: {} }), null);
  });
});

describe('candidatePorts', () => {
  it('drops TLS and the Caddy admin port and tries the usual web ports first', () => {
    assert.deepEqual(candidatePorts([2019, 443, 8080, 80]), [80, 8080]);
    assert.deepEqual(candidatePorts([9999, 3000]), [3000, 9999]);
  });

  it('falls back to 80 when the image declares nothing usable', () => {
    assert.deepEqual(candidatePorts([]), [80]);
    assert.deepEqual(candidatePorts([443]), [80]);
  });
});
