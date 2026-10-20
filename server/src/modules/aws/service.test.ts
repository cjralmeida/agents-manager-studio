import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amplifyBuildSpec, caddySite } from './service.js';

describe('amplifyBuildSpec', () => {
  it('picks the package manager by the lockfile and publishes the output folder', () => {
    const spec = amplifyBuildSpec('build');
    assert.match(spec, /npm install -g pnpm@9/);
    assert.match(spec, /yarn install --frozen-lockfile/);
    assert.match(spec, /npm ci/);
    assert.match(spec, /baseDirectory: build/);
    // A plain YAML list item cannot hold ": " (it would be read as a map).
    for (const line of spec.split('\n').filter((entry) => entry.trim().startsWith('- '))) assert.doesNotMatch(line.trim().slice(2), /: /);
  });
});

describe('caddySite', () => {
  it('writes the site file for the host and port unless the main Caddyfile already has the host', () => {
    const script = caddySite('api.v2.globalfarm.com.br', 8081, 'ams-globalfarm-hom').join('\n');
    assert.match(script, /api\\.v2\\.globalfarm\\.com\\.br/);
    assert.match(script, /reverse_proxy 127\.0\.0\.1:8081/);
    assert.match(script, /\/etc\/caddy\/sites\/ams-globalfarm-hom\.caddy/);
    assert.match(script, /import \/etc\/caddy\/sites\/\*\.caddy/);
  });
});
