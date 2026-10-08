import { timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '../../db.js';
import { type AgentStatus, Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import type { RateLimitInfo, UsageTotals } from '../usage/calc.js';
import { recordAgentUsage, recordPlanUsageForAgent } from '../usage/service.js';
import { hashSecret } from './runtime.js';
import { addEvent, onAgentIdle } from './service.js';

/** Statuses the runner must not change: the user or the server owns them. */
const LOCKED_STATUSES: AgentStatus[] = ['CANCELLED', 'FINALIZING'];
const POLL_INTERVAL_MS = 500;

/** The container proves who it is with the secret it received at start (only its hash is stored). */
export async function authenticateRunner(agentId: string, authorization: string | undefined) {
  const secret = authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { secretHash: true } });
  const expected = Buffer.from(agent?.secretHash ?? '', 'hex');
  const received = Buffer.from(hashSecret(secret), 'hex');
  if (!secret || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new HttpError(401, 'Não autorizado.');
  }
  return received.toString('hex');
}

/**
 * Long-poll: returns pending messages/answers as soon as there are any, or [] after the timeout.
 * Stops when the runner disconnects or its container was replaced, so a dead container never
 * "receives" (and loses) a message meant for the next one.
 */
export async function takeInbox(agentId: string, secretHash: string, timeoutMs: number, signal: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal.aborted) return [];
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { secretHash: true } });
    if (agent?.secretHash !== secretHash) return [];

    const items = await prisma.agentInbox.findMany({
      where: { agentId, deliveredAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, kind: true, payload: true },
    });
    if (items.length > 0) {
      await prisma.agentInbox.updateMany({
        where: { id: { in: items.map((item) => item.id) } },
        data: { deliveredAt: new Date() },
      });
      return items;
    }
    if (Date.now() >= deadline) return [];
    await sleep(POLL_INTERVAL_MS);
  }
}

export type RunnerEvent =
  | { type: 'session'; data: { sessionId: string } }
  | { type: 'assistant_text'; data: { text: string } }
  | { type: 'tool_use'; data: { name: string; summary: string } }
  | { type: 'question'; data: { questions: unknown[] } }
  | { type: 'turn_end'; data: { isError: boolean; text: string; durationMs?: number } }
  | { type: 'sleeping'; data: Record<string, never> }
  | { type: 'usage'; data: { models: UsageTotals } }
  | { type: 'rate_limit'; data: RateLimitInfo };

/** Stores the runner events in the timeline and moves the agent through its statuses. */
export async function applyRunnerEvents(agentId: string, events: RunnerEvent[]) {
  for (const event of events) {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const locked = LOCKED_STATUSES.includes(agent.status);
    const data: Prisma.AgentUpdateInput = { lastActivityAt: new Date() };

    switch (event.type) {
      case 'session':
        data.sessionId = event.data.sessionId;
        if (!locked && agent.status === 'PREPARING') data.status = 'RUNNING';
        break;
      case 'assistant_text':
      case 'tool_use':
        await addEvent(agentId, event.type, event.data);
        // A queued message started a new turn after the previous one ended.
        if (!locked && (agent.status === 'PREPARING' || agent.status === 'READY_FOR_REVIEW')) data.status = 'RUNNING';
        break;
      case 'question':
        await addEvent(agentId, 'question', event.data as Prisma.InputJsonValue);
        if (!locked) {
          data.status = 'WAITING_INPUT';
          data.pendingQuestion = event.data.questions as Prisma.InputJsonValue;
        }
        break;
      case 'turn_end': {
        await addEvent(agentId, 'turn_end', event.data);
        const queued = await prisma.agentInbox.count({ where: { agentId, deliveredAt: null } });
        if (!locked && agent.status === 'RUNNING' && queued === 0) data.status = 'READY_FOR_REVIEW';
        data.errorMessage = event.data.isError ? event.data.text.slice(0, 500) : null;
        break;
      }
      case 'usage':
        await recordAgentUsage(agentId, event.data.models);
        continue;
      case 'rate_limit':
        await recordPlanUsageForAgent(agentId, event.data);
        continue;
      case 'sleeping':
        await addEvent(agentId, 'status', { message: 'Container pausado por inatividade; ele volta quando você responder.' });
        break;
    }

    await prisma.agent.update({ where: { id: agentId }, data });
  }

  // Automatic agents conclude as soon as a turn ends with nothing left to do; not awaited so the runner is not held.
  if (events.some((event) => event.type === 'turn_end')) void onAgentIdle(agentId);
}
