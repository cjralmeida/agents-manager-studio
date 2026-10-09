import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { parseInput } from '../../lib/validation.js';
import { AGENT_TOOL_NAMES, runAgentTool } from '../agent-tools/service.js';
import { assertOwnsProfile, assertOwnsProject } from '../auth/ownership.js';
import { applyRunnerEvents, authenticateRunner, type RunnerEvent, takeInbox } from './runner-api.js';
import {
  AGENT_MODELS,
  answerQuestion,
  cancelAgent,
  deleteAgent,
  finalizeAgent,
  getAgent,
  getAgentDiff,
  launchAgent,
  listAgentEvents,
  listAgents,
  sendMessage,
} from './service.js';

const idParams = z.object({ id: z.uuid() });

const listQuery = z
  .object({
    workspaceId: z.uuid().optional(),
    /** Executions of one workspace agent. */
    profileId: z.uuid().optional(),
    /** Executions without a workspace agent ("avulsos"). */
    unassigned: z.stringbool().optional(),
  })
  .strict();

const launchBody = z
  .object({
    projectId: z.uuid().nullable().optional(),
    profileId: z.uuid().optional(),
    prompt: z.string().trim().min(1).max(20_000),
    title: z.string().trim().max(120).optional(),
    model: z.enum(AGENT_MODELS).optional(),
    baseBranch: z
      .string()
      .trim()
      .max(200)
      .regex(/^[\w./-]*$/, 'Nome de branch inválido.')
      .optional(),
    taskItemId: z.string().min(1).max(200).optional(),
    confirmHighUsage: z.boolean().optional(),
  })
  .strict();

const eventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) }).strict();

const messageBody = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();

const answerBody = z
  .object({ answers: z.record(z.string(), z.string().trim().min(1).max(5_000)) })
  .strict()
  .refine((body) => Object.keys(body.answers).length > 0, 'Responda ao menos uma pergunta.');

export async function agentRoutes(app: FastifyInstance) {
  app.get('/agents', async (request) => listAgents(request.user.id, parseInput(listQuery, request.query)));

  app.post('/agents', async (request, reply) => {
    const input = parseInput(launchBody, request.body);
    if (input.projectId) await assertOwnsProject(input.projectId, request.user.id);
    if (input.profileId) await assertOwnsProfile(input.profileId, request.user.id);
    const agent = await launchAgent(input);
    return reply.code(201).send(agent);
  });

  app.get('/agents/:id', async (request) => getAgent(parseInput(idParams, request.params).id));

  app.get('/agents/:id/events', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return listAgentEvents(id, parseInput(eventsQuery, request.query).after);
  });

  app.get('/agents/:id/diff', async (request) => getAgentDiff(parseInput(idParams, request.params).id));

  app.post('/agents/:id/messages', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return sendMessage(id, parseInput(messageBody, request.body).text);
  });

  app.post('/agents/:id/answer', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return answerQuestion(id, parseInput(answerBody, request.body).answers);
  });

  app.post('/agents/:id/finalize', async (request) => finalizeAgent(parseInput(idParams, request.params).id));

  app.post('/agents/:id/cancel', async (request) => cancelAgent(parseInput(idParams, request.params).id));

  app.delete('/agents/:id', async (request, reply) => {
    await deleteAgent(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });
}

const inboxQuery = z.object({ timeoutMs: z.coerce.number().int().min(0).max(30_000).default(20_000) }).strict();

const runnerEvents = z
  .object({
    events: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('session'), data: z.object({ sessionId: z.string().min(1) }) }),
          z.object({ type: z.literal('assistant_text'), data: z.object({ text: z.string() }) }),
          z.object({ type: z.literal('tool_use'), data: z.object({ name: z.string(), summary: z.string() }) }),
          z.object({ type: z.literal('question'), data: z.object({ questions: z.array(z.unknown()).min(1) }) }),
          z.object({
            type: z.literal('turn_end'),
            data: z.object({ isError: z.boolean(), text: z.string(), durationMs: z.number().optional() }),
          }),
          z.object({ type: z.literal('sleeping'), data: z.object({}).strict() }),
          z.object({
            type: z.literal('usage'),
            data: z.object({
              models: z.record(
                z.string().max(200),
                z.object({
                  inputTokens: z.number().min(0),
                  outputTokens: z.number().min(0),
                  cacheReadInputTokens: z.number().min(0),
                  cacheCreationInputTokens: z.number().min(0),
                  costUSD: z.number().min(0),
                }),
              ),
            }),
          }),
          z.object({ type: z.literal('rate_limit'), data: z.looseObject({}) }),
        ]),
      )
      .max(200),
  })
  .strict();

/** Endpoints called by the runner inside the agent container (authenticated by its per-container secret). */
export async function agentRunnerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    const { id } = parseInput(idParams, request.params);
    await authenticateRunner(id, request.headers.authorization);
  });

  app.get('/internal/agents/:id/inbox', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const secretHash = await authenticateRunner(id, request.headers.authorization);
    // The response "close" fires when the runner disconnects before we answer.
    const disconnected = new AbortController();
    reply.raw.on('close', () => disconnected.abort());
    return takeInbox(id, secretHash, parseInput(inboxQuery, request.query).timeoutMs, disconnected.signal);
  });

  app.post('/internal/agents/:id/events', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await applyRunnerEvents(id, parseInput(runnerEvents, request.body).events as RunnerEvent[]);
    return reply.code(204).send();
  });

  /** Studio tools (board, result) called by the agent; errors go back as text the agent can act on. */
  app.post('/internal/agents/:id/tools/:tool', async (request) => {
    const { id, tool } = parseInput(toolParams, request.params);
    try {
      return { ok: true, data: await runAgentTool(id, tool, parseInput(toolArgs, request.body ?? {})) };
    } catch (error) {
      if (error instanceof HttpError || error instanceof Error) return { ok: false, error: error.message };
      throw error;
    }
  });
}

const toolParams = z.object({ id: z.uuid(), tool: z.enum(AGENT_TOOL_NAMES) });
const toolArgs = z.record(z.string(), z.unknown());
