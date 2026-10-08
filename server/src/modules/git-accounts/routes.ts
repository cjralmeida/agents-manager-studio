import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import {
  createGitAccount,
  deleteGitAccount,
  listGitAccounts,
  updateGitAccount,
  verifyGitAccount,
} from './service.js';

const idParams = z.object({ id: z.uuid() });

const label = z.string().trim().min(1).max(80);
// Terminals wrap long tokens when copying; tokens never contain whitespace.
const token = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().min(8).max(500));

const createBody = z
  .object({
    provider: z.enum(['GITHUB', 'GITLAB']),
    label,
    // Hostname with optional port, without scheme or path (e.g. gitlab.company.com).
    host: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+(:\d+)?$/, 'Informe só o host, sem https:// nem caminho.')
      .optional(),
    token,
  })
  .strict()
  .transform((body) => ({ ...body, host: body.host ?? (body.provider === 'GITHUB' ? 'github.com' : 'gitlab.com') }));

const updateBody = z
  .object({ label: label.optional(), token: token.optional() })
  .strict()
  .refine((body) => body.label !== undefined || body.token !== undefined, 'Informe o nome ou um novo token.');

export async function gitAccountRoutes(app: FastifyInstance) {
  app.get('/git-accounts', async () => listGitAccounts());

  app.post('/git-accounts', async (request, reply) => {
    const account = await createGitAccount(parseInput(createBody, request.body));
    return reply.code(201).send(account);
  });

  app.patch('/git-accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateGitAccount(id, parseInput(updateBody, request.body));
  });

  app.post('/git-accounts/:id/verify', async (request) => verifyGitAccount(parseInput(idParams, request.params).id));

  app.delete('/git-accounts/:id', async (request, reply) => {
    await deleteGitAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
