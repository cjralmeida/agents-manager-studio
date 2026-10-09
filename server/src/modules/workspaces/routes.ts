import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { listCloneJobs, startClone } from './clone.js';
import { createProject, listRepositoryOwners } from './create-project.js';
import { listAccountRepositories } from './repositories.js';
import {
  createWorkspace,
  deleteMissingWorkspace,
  getWorkspace,
  listWorkspaces,
  scanWorkspaces,
  setWorkspaceIgnored,
} from './service.js';

const listQuery = z
  .object({ includeIgnored: z.enum(['true', 'false']).default('false') })
  .strict()
  .transform((query) => ({ includeIgnored: query.includeIgnored === 'true' }));

const repositoriesQuery = z.object({ search: z.string().max(100).default('') }).strict();

const cloneBody = z
  .object({
    url: z.string().trim().min(1).max(500),
    folder: z.string().trim().max(80).optional(),
    branch: z
      .string()
      .trim()
      .max(200)
      .regex(/^[\w./-]*$/, 'Nome de branch inválido.')
      .optional(),
  })
  .strict();

const projectBody = z
  .object({
    name: z.string().max(200),
    description: z.string().trim().max(300).optional(),
    remote: z.object({ accountId: z.uuid(), owner: z.string().trim().min(1).max(200), visibility: z.enum(['private', 'public']) }).strict().nullable(),
  })
  .strict();

const createBody = z.object({ name: z.string().max(200) }).strict();

const idParams = z.object({ id: z.uuid() });

const updateBody = z.object({ isIgnored: z.boolean() }).strict();

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/workspaces', async (request) => listWorkspaces(request.user.id, parseInput(listQuery, request.query)));

  app.post('/workspaces/scan', async (request) => scanWorkspaces(request.user.id));

  /** Repositories the workspace git accounts can reach, to pick one to clone. */
  app.get('/workspaces/:id/repositories', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return listAccountRepositories(id, parseInput(repositoriesQuery, request.query).search);
  });

  /** Clones a repository into the workspace (in the background); the project appears when it finishes. */
  app.post('/workspaces/:id/clones', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    return reply.code(202).send(await startClone(id, parseInput(cloneBody, request.body), request.log));
  });

  /** Where the workspace git accounts can create repositories (user, organizations, groups). */
  app.get('/workspaces/:id/repository-owners', async (request) => listRepositoryOwners(parseInput(idParams, request.params).id));

  /** New project folder with git, optionally with a new GitHub/GitLab repository as origin. */
  app.post('/workspaces/:id/projects', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    return reply.code(201).send(await createProject(id, parseInput(projectBody, request.body)));
  });

  app.get('/workspaces/:id/clones', async (request) => listCloneJobs(parseInput(idParams, request.params).id));

  /** Creates a new workspace folder in the central folder. */
  app.post('/workspaces', async (request, reply) => {
    const { name } = parseInput(createBody, request.body);
    return reply.code(201).send(await createWorkspace(request.user.id, name));
  });

  app.get('/workspaces/:id', async (request) => getWorkspace(parseInput(idParams, request.params).id));

  app.patch('/workspaces/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { isIgnored } = parseInput(updateBody, request.body);
    return setWorkspaceIgnored(id, isIgnored);
  });

  app.delete('/workspaces/:id', async (request, reply) => {
    await deleteMissingWorkspace(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}
