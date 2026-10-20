import type { FastifyInstance } from 'fastify';
import { workspaceIdsOf } from '../auth/ownership.js';
import { onLiveEvent } from './bus.js';

const HEARTBEAT_MS = 25_000;

export async function liveRoutes(app: FastifyInstance) {
  /** The user's stream of changes (only their own workspaces); the browser reconnects by itself when it drops. */
  app.get('/events', async (request, reply) => {
    const userId = request.user.id;
    let own = new Set(await workspaceIdsOf(userId));
    let ownAt = Date.now();
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n\n');
    const send = (data: unknown) => raw.write(`data: ${JSON.stringify(data)}\n\n`);
    const stop = onLiveEvent((event) => {
      void (async () => {
        // New workspaces of the user are picked up within a minute.
        if (!own.has(event.workspaceId) && Date.now() - ownAt > 60_000) {
          own = new Set(await workspaceIdsOf(userId));
          ownAt = Date.now();
        }
        if (own.has(event.workspaceId)) send(event);
      })().catch(() => undefined);
    });
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      stop();
    });
  });
}
