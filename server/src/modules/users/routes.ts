import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { generatePassword, hashPassword } from '../../lib/password.js';
import { parseInput } from '../../lib/validation.js';
import { requireAdmin } from '../auth/guard.js';
import { endUserSessions } from '../auth/sessions.js';
import { emailProblem, normalizeEmail } from './rules.js';

const idParams = z.object({ id: z.uuid() });
const role = z.enum(['ADMIN', 'MEMBER']);
const createBody = z.object({ email: z.string().max(200), name: z.string().trim().min(1).max(100), role: role.default('MEMBER') }).strict();
const updateBody = z.object({ name: z.string().trim().min(1).max(100).optional(), role: role.optional(), isActive: z.boolean().optional() }).strict();

const userResponse = (user: {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  _count: { workspaces: number };
}) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
  workspaceCount: user._count.workspaces,
});

const withCounts = { _count: { select: { workspaces: true } } } as const;

/** User administration (admins only). New and reset passwords are generated and returned once. */
export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => requireAdmin(request));

  app.get('/users', async () => (await prisma.user.findMany({ include: withCounts, orderBy: { name: 'asc' } })).map(userResponse));

  app.post('/users', async (request, reply) => {
    const input = parseInput(createBody, request.body);
    const email = normalizeEmail(input.email);
    const problem = emailProblem(email);
    if (problem) throw new HttpError(422, problem);
    if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Já existe um usuário com este e-mail.');
    const password = generatePassword();
    const user = await prisma.user.create({
      data: { email, name: input.name, role: input.role, passwordHash: await hashPassword(password) },
      include: withCounts,
    });
    return reply.code(201).send({ user: userResponse(user), password });
  });

  app.patch('/users/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(updateBody, request.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('Usuário não encontrado.');
    if (id === request.user.id && (input.isActive === false || input.role === 'MEMBER')) {
      throw new HttpError(422, 'Você não pode desativar nem tirar o administrador de você mesmo.');
    }
    const updated = await prisma.user.update({ where: { id }, data: input, include: withCounts });
    if (input.isActive === false) await endUserSessions(id);
    return userResponse(updated);
  });

  /** Only users without workspaces or accounts can be deleted; the others are deactivated. */
  app.delete('/users/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    if (id === request.user.id) throw new HttpError(422, 'Você não pode excluir você mesmo.');
    const user = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { workspaces: true, gitAccounts: true, agentAccounts: true, renderAccounts: true } } },
    });
    if (!user) throw notFound('Usuário não encontrado.');
    const owned = Object.values(user._count).reduce((total, count) => total + count, 0);
    if (owned > 0) throw new HttpError(409, 'Este usuário tem workspaces ou contas. Desative-o em vez de excluir.');
    await prisma.user.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post('/users/:id/password', async (request) => {
    const { id } = parseInput(idParams, request.params);
    if (!(await prisma.user.findUnique({ where: { id } }))) throw notFound('Usuário não encontrado.');
    const password = generatePassword();
    await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
    await endUserSessions(id);
    return { password };
  });
}
