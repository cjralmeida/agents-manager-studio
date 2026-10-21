// "Navegador ao vivo": finds the Chromium browsers opened in this container (the image wraps Playwright's Chromium so
// each one also listens on a local DevTools port and writes DevToolsActivePort in its profile folder under /tmp),
// reports their pages to the Studio and, only while someone watches the agent's page, sends a frame of each page from
// Chromium's screencast. It only looks: no clicks, no navigation, nothing that changes what the tests see.
import { readdir, readFile } from 'node:fs/promises';

const IDLE_MS = 2000;
const WATCHING_MS = 500;
const MAX_PAGES = 4;

export function startBrowserView(api, log) {
  let watching = false;
  let reported = false;
  /** Screencasts by page id: the socket and the latest frame (base64 JPEG). */
  const casts = new Map();

  async function openPages() {
    const pages = [];
    for (const dir of await readdir('/tmp').catch(() => [])) {
      const text = await readFile(`/tmp/${dir}/DevToolsActivePort`, 'utf8').catch(() => null);
      const port = Number(text?.split('\n')[0]);
      if (!port) continue;
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
        .then((response) => response.json())
        .catch(() => []);
      for (const target of targets) {
        if (target.type === 'page' && target.webSocketDebuggerUrl) {
          pages.push({ id: target.id, url: target.url ?? '', title: target.title ?? '', socket: target.webSocketDebuggerUrl });
        }
      }
    }
    return pages.slice(0, MAX_PAGES);
  }

  function cast(page) {
    const socket = new WebSocket(page.socket);
    const entry = { socket, frame: null, sent: null };
    let id = 0;
    const send = (method, params = {}) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id: ++id, method, params }));
    socket.onopen = () => send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 960, maxHeight: 720, everyNthFrame: 1 });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method !== 'Page.screencastFrame') return;
      entry.frame = message.params.data;
      send('Page.screencastFrameAck', { sessionId: message.params.sessionId });
    };
    socket.onerror = () => {};
    socket.onclose = () => casts.get(page.id) === entry && casts.delete(page.id);
    casts.set(page.id, entry);
  }

  function stop(pageId) {
    const entry = casts.get(pageId);
    casts.delete(pageId);
    try {
      entry?.socket.close();
    } catch {
      // Already closed with its page.
    }
  }

  async function tick() {
    const pages = await openPages();
    for (const pageId of [...casts.keys()]) if (!watching || !pages.some((page) => page.id === pageId)) stop(pageId);
    if (watching) for (const page of pages) if (!casts.has(page.id)) cast(page);
    // Nothing open and nothing reported: no call at all.
    if (pages.length === 0 && !reported) return;
    const frames = [];
    for (const [pageId, entry] of casts) {
      if (entry.frame && entry.frame !== entry.sent) {
        entry.sent = entry.frame;
        frames.push({ pageId, data: entry.frame });
      }
    }
    const answer = await api('/browser', {
      method: 'POST',
      body: JSON.stringify({ pages: pages.map(({ id, url, title }) => ({ id, url: url.slice(0, 2000), title: title.slice(0, 300) })), frames }),
    });
    watching = Boolean(answer?.watching);
    reported = pages.length > 0;
  }

  const loop = async () => {
    try {
      await tick();
    } catch (error) {
      log('Browser view failed', { error: String(error) });
    }
    setTimeout(loop, watching ? WATCHING_MS : IDLE_MS).unref();
  };
  setTimeout(loop, IDLE_MS).unref();
}
