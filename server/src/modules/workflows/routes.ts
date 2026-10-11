import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput, patchSchema } from '../../lib/validation.js';
import { workflowSchema } from './definition.js';
import {
  cancelWorkflowRun,
  createWorkflow,
  deleteWorkflow,
  getRun,
  listRuns,
  listWorkflows,
  startWorkflow,
  updateWorkflow,
  activeRunTasks,
  listActiveRuns,
} from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const workflowBody = workflowSchema;

const startBody = z.object({ message: z.string().trim().max(20_000).optional() }).strict();
const runsQuery = z.object({ workflowId: z.uuid().optional() }).strict();

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/workspaces/:id/workflows', async (request) => listWorkflows(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/workflows', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await createWorkflow(id, parseInput(workflowBody, request.body)));
  });

  app.patch('/workflows/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return updateWorkflow(id, parseInput(patchSchema(workflowBody), request.body));
  });

  app.delete('/workflows/:id', async (request, reply) => {
    await deleteWorkflow(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });

  /** Conversation trigger: starts a run with the message. Board trigger: checks the board now. */
  app.post('/workflows/:id/start', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return startWorkflow(id, parseInput(startBody, request.body ?? {}).message, request.log);
  });

  app.get('/workspaces/:id/workflow-runs', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return listRuns(id, parseInput(runsQuery, request.query).workflowId);
  });

  /** Board tasks that running workflows are working on, in every workspace the user sees. */
  app.get('/workflow-runs/active-tasks', async (request) => activeRunTasks(request.user.id));

  /** Running workflow runs of every workspace the user sees. */
  app.get('/workflow-runs/active', async (request) => listActiveRuns(request.user.id));

  app.get('/workflow-runs/:id', async (request) => getRun(parseInput(idParams, request.params).id));

  app.post('/workflow-runs/:id/cancel', async (request) => cancelWorkflowRun(parseInput(idParams, request.params).id, request.log));
}
