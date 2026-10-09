import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { sessionCookie } from '../../lib/cookies.js';
import { HttpError } from '../../lib/errors.js';
import { hashPassword, passwordProblem, verifyPassword } from '../../lib/password.js';
import { parseInput } from '../../lib/validation.js';
import { THEMES, normalizeEmail } from '../users/rules.js';
import { sessionToken } from './guard.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, createSession, endSession, endUserSessions, toAuthUser } from './sessions.js';

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(200) }).strict();
const profileBody = z.object({ name: z.string().trim().min(1).max(100).optional(), theme: z.enum(THEMES).optional() }).strict();
const passwordBody = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).strict();

/** Failed logins per e-mail and address; after MAX_FAILURES the login waits until the window ends. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function checkThrottle(key: string) {
  const entry = failures.get(key);
  if (entry && entry.resetAt < Date.now()) failures.delete(key);
  if ((failures.get(key)?.count ?? 0) >= MAX_FAILURES) throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
}

function recordFailure(key: string) {
  const entry = failures.get(key) ?? { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
  failures.set(key, { ...entry, count: entry.count + 1 });
}

/** Compared when the e-mail does not exist, so both cases take the same time. */
let dummyHash: Promise<string> | null = null;

const setSession = (reply: FastifyReply, token: string, maxAge = SESSION_MAX_AGE_SECONDS) =>
  reply.header('Set-Cookie', sessionCookie(SESSION_COOKIE, token, maxAge, config.cookieSecure));

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const { email: rawEmail, password } = parseInput(loginBody, request.body);
    const email = normalizeEmail(rawEmail);
    const key = `${request.ip}|${email}`;
    checkThrottle(key);

    const user = await prisma.user.findUnique({ where: { email } });
    dummyHash ??= hashPassword('senha-que-nao-existe');
    const valid = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash), false);
    if (!user || !valid || !user.isActive) {
      recordFailure(key);
      throw new HttpError(401, user && valid && !user.isActive ? 'Este usuário está desativado.' : 'E-mail ou senha incorretos.');
    }
    failures.delete(key);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    setSession(reply, await createSession(user.id));
    return toAuthUser(user);
  });

  app.post('/auth/logout', async (request, reply) => {
    await endSession(sessionToken(request));
    setSession(reply, '', 0);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request) => request.user);

  app.patch('/auth/me', async (request) => {
    const input = parseInput(profileBody, request.body);
    return toAuthUser(await prisma.user.update({ where: { id: request.user.id }, data: input }));
  });

  /** Changing the password signs out every other session of the user. */
  app.post('/auth/me/password', async (request, reply) => {
    const { currentPassword, newPassword } = parseInput(passwordBody, request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.id } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new HttpError(422, 'A senha atual não confere.');
    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(422, problem);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await endUserSessions(user.id, sessionToken(request));
    return reply.code(204).send();
  });
}
