import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readCookie } from '../../lib/cookies.js';
import { HttpError } from '../../lib/errors.js';
import { assertOwner } from './ownership.js';
import { type AuthUser, SESSION_COOKIE, userForToken } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user (every /api route except the public ones below). */
    user: AuthUser;
  }
}

/** Routes without a session: login, health check, git webhooks (checked by their secret) and agent containers (they use their own token). */
const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health', '/api/webhooks/gitlab', '/api/webhooks/github']);
const isPublic = (url: string) => PUBLIC_ROUTES.has(url) || url.startsWith('/api/internal/');

export const sessionToken = (request: FastifyRequest) => readCookie(request.headers.cookie, SESSION_COOKIE);

/**
 * Installed on the /api scope (not as a plugin, so it covers every route registered there): requires a session,
 * then checks that the entity in ":id" belongs to the user.
 */
export function installAuthGuard(api: FastifyInstance) {
  api.decorateRequest('user', null as unknown as AuthUser);

  api.addHook('onRequest', async (request) => {
    const url = request.routeOptions.url ?? '';
    if (isPublic(url)) return;
    const user = await userForToken(sessionToken(request));
    if (!user) throw new HttpError(401, 'Faça login para continuar.');
    request.user = user;
  });

  api.addHook('preHandler', async (request) => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (request.user && typeof id === 'string') await assertOwner(request.routeOptions.url ?? '', id, request.user.id);
  });
}

export function requireAdmin(request: FastifyRequest) {
  if (request.user.role !== 'ADMIN') throw new HttpError(403, 'Só administradores podem fazer isso.');
}
