import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { stepSchema, triggerSchema } from './definition.js';
import {
  cancelWorkflowRun,
  createWorkflow,
  deleteWorkflow,
  getRun,
  listRuns,
  listWorkflows,
  startWorkflow,
  updateWorkflow,
} from './service.js';

const workspaceParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

const workflowBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    isEnabled: z.boolean().default(true),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(12),
    maxConcurrentRuns: z.number().int().min(1).max(5).default(1),
  })
  .strict();

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
    return updateWorkflow(id, parseInput(workflowBody.partial(), request.body));
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

  app.get('/workflow-runs/:id', async (request) => getRun(parseInput(idParams, request.params).id));

  app.post('/workflow-runs/:id/cancel', async (request) => cancelWorkflowRun(parseInput(idParams, request.params).id, request.log));
}
