import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';
import type { User } from '../../generated/prisma/client.js';

export const SESSION_COOKIE = 'ams_session';
const SESSION_DAYS = 30;
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86_400;
/** Expiry slides on use, but the row is touched at most once an hour. */
const TOUCH_EVERY_MS = 60 * 60_000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const expiryFromNow = () => new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  theme: string;
}

export const toAuthUser = ({ id, email, name, role, theme }: User): AuthUser => ({ id, email, name, role, theme });

/** New session; the token goes to the cookie, only its hash is stored. */
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { id: hashToken(token), userId, expiresAt: expiryFromNow() } });
  return token;
}

export async function userForToken(token: string | null): Promise<AuthUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: expiryFromNow() } }).catch(() => undefined);
  }
  return toAuthUser(session.user);
}

export async function endSession(token: string | null) {
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
}

/** Signs a user out everywhere (password changed or account disabled), optionally keeping the current session. */
export async function endUserSessions(userId: string, keepToken?: string | null) {
  await prisma.session.deleteMany({ where: { userId, ...(keepToken && { NOT: { id: hashToken(keepToken) } }) } });
}

export async function deleteExpiredSessions() {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
