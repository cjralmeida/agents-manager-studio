import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { browserFrame, reportBrowser, testFailures, watchBrowser } from './browser-view.js';

describe('navegador ao vivo', () => {
  it('sends frames only after someone watches, and shows the open pages', () => {
    const agent = 'agent-live';
    const page = { id: 'A1B2', url: 'https://hom.example/login', title: 'Login' };
    assert.deepEqual(reportBrowser(agent, { pages: [page], frames: [] }), { watching: false });

    const view = watchBrowser(agent);
    assert.equal(view.live, true);
    assert.deepEqual(view.pages, [{ ...page, frameAt: null }]);
    assert.deepEqual(reportBrowser(agent, { pages: [page], frames: [{ pageId: 'A1B2', data: Buffer.from('jpeg').toString('base64') }] }), { watching: true });
    assert.equal(browserFrame(agent, 'A1B2')?.toString(), 'jpeg');
  });

  it('forgets the frames of closed pages', () => {
    const agent = 'agent-closed';
    watchBrowser(agent);
    reportBrowser(agent, { pages: [{ id: 'P1', url: 'about:blank', title: '' }], frames: [{ pageId: 'P1', data: 'AA==' }] });
    reportBrowser(agent, { pages: [], frames: [] });
    assert.equal(browserFrame(agent, 'P1'), null);
    assert.equal(watchBrowser(agent).live, false);
  });
});

describe('falhas dos testes', () => {
  it('lists the screenshot, trace and video of each failed test, skipping node_modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'failures-'));
    try {
      const failed = path.join(root, 'hom', 'test-results', 'login-entra-chromium');
      await mkdir(failed, { recursive: true });
      await writeFile(path.join(failed, 'test-failed-1.png'), '');
      await writeFile(path.join(failed, 'trace.zip'), '');
      await writeFile(path.join(failed, 'video.webm'), '');
      await mkdir(path.join(root, 'hom', 'test-results', 'passed-without-artifacts'), { recursive: true });
      await mkdir(path.join(root, 'node_modules', 'x', 'test-results', 'other'), { recursive: true });
      await writeFile(path.join(root, 'node_modules', 'x', 'test-results', 'other', 'a.png'), '');

      const failures = await testFailures(root.split(path.sep).join('/'));
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.name, 'login-entra-chromium');
      assert.deepEqual(failures[0]!.screenshots, ['hom/test-results/login-entra-chromium/test-failed-1.png']);
      assert.equal(failures[0]!.trace, 'hom/test-results/login-entra-chromium/trace.zip');
      assert.equal(failures[0]!.video, 'hom/test-results/login-entra-chromium/video.webm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
