import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { containerLogs, inspectContainer, removeContainer } from '../../lib/docker.js';
import { largerSize, limitRunningAgents, sizeOfAgent } from './resources.js';
import { addEvent, ensureContainer, markFailed, onAgentIdle, sendMessage } from './service.js';

const INTERVAL_MS = 5_000;
const MAX_CRASH_RESUMES = 2;
/** A queued message older than this with no container for the agent is taken as stranded. */
const STRANDED_AFTER_MS = 2 * 60_000;
const CRASH_RESUME_MARK = 'O container do agente parou de forma inesperada';
const CRASH_RESUME_MESSAGE =
  'O seu container parou de forma inesperada (ex.: o computador desligou) e foi reiniciado. Continue exatamente de onde parou: ' +
  'confira o estado da sua cópia (git status, arquivos gerados, testes) e siga a tarefa até o fim.';

const OOM_RESUME_MESSAGE =
  'O seu container ficou sem memória e foi reiniciado com mais memória. Continue de onde parou (confira git status e os ' +
  'arquivos gerados); evite rodar muitas coisas pesadas ao mesmo tempo (ex.: build e suíte de testes em paralelo).';

/** An automatic agent that finished but whose delivery failed (e.g. Docker timed out removing its container) is retried. */
const UNDELIVERED_AFTER_MS = 5 * 60_000;
const deliveryRetries = new Map<string, number>();

/** How many times this agent was resumed after a crash in the last hour. */
function recentCrashResumes(agentId: string) {
  return prisma.agentEvent.count({
    where: {
      agentId,
      type: 'status',
      createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
      data: { path: ['message'], string_starts_with: CRASH_RESUME_MARK },
    },
  });
}

/**
 * Watches agent containers: clears the ones that exited (idle pause = exit 0),
 * fails agents whose container crashed, and restarts containers for messages that arrived meanwhile.
 */
async function checkContainers(log: FastifyBaseLogger) {
  const agents = await prisma.agent.findMany({ where: { containerId: { not: null } } });

  for (const agent of agents) {
    const containerId = agent.containerId!;
    const state = await inspectContainer(containerId);
    if (state?.running) continue;

    const exitCode = state?.exitCode ?? null;
    const logs = state && exitCode !== 0 ? await containerLogs(containerId, 20).catch(() => null) : null;
    await removeContainer(containerId).catch(() => undefined);

    // Skips agents whose container was replaced in the meantime.
    const cleared = await prisma.agent.updateMany({
      where: { id: agent.id, containerId },
      data: { containerId: null, secretHash: null },
    });
    if (cleared.count === 0) continue;

    // Out of memory is the size, not the work: the session goes on in a container one size up (not counted as a crash).
    if (state?.oomKilled && ['PREPARING', 'RUNNING'].includes(agent.status) && agent.sessionId) {
      const size = await sizeOfAgent(agent);
      const larger = largerSize(size.name as Parameters<typeof largerSize>[0]);
      if (larger) {
        log.warn({ agentId: agent.id, from: size.name, to: larger }, 'Agent container ran out of memory');
        await prisma.agent.update({ where: { id: agent.id }, data: { resourceSize: larger } });
        await addEvent(agent.id, 'status', { message: `O container ficou sem memória (limite de ${size.memoryMb / 1024} GB): retomando no tamanho ${larger}.` });
        await sendMessage(agent.id, OOM_RESUME_MESSAGE).catch((error: unknown) => log.warn({ agentId: agent.id, err: error }, 'OOM resume failed'));
        continue;
      }
    }

    if (exitCode !== 0) {
      const tail = logs ? `${logs.stderr}\n${logs.stdout}`.trim().slice(-800) : '';
      log.warn({ agentId: agent.id, exitCode }, 'Agent container stopped unexpectedly');
      // A container killed from outside (the computer shut down or slept, Docker restarted) is not a failure of the work:
      // the session is resumed, a couple of times per hour, before the agent is given up as failed.
      if (agent.status === 'RUNNING' && agent.sessionId && (await recentCrashResumes(agent.id)) < MAX_CRASH_RESUMES) {
        await addEvent(agent.id, 'status', { message: `${CRASH_RESUME_MARK} (código ${exitCode ?? '?'}); retomando a sessão.` });
        await sendMessage(agent.id, CRASH_RESUME_MESSAGE).catch((error: unknown) => log.warn({ agentId: agent.id, err: error }, 'Crash resume failed'));
        continue;
      }
      if (['PREPARING', 'RUNNING'].includes(agent.status)) {
        await markFailed(agent.id, new Error(`O container do agente parou (código ${exitCode ?? '?'}). ${tail}`));
      } else {
        await addEvent(agent.id, 'error', { message: `O container do agente parou (código ${exitCode ?? '?'}).` });
      }
      continue;
    }

    const pending = await prisma.agentInbox.count({ where: { agentId: agent.id, deliveredAt: null } });
    if (pending > 0 && agent.status !== 'CANCELLED') await ensureContainer(agent.id);
  }

  // A message or answer that arrived while no container was starting it (e.g. the server restarted right after it was
  // queued) would wait forever: the agent is started for it. Agents held for the plan limit wait for their time.
  const stranded = await prisma.agent.findMany({
    where: {
      containerId: null,
      limitResumeAt: null,
      status: { in: ['PREPARING', 'RUNNING'] },
      inbox: { some: { deliveredAt: null, createdAt: { lt: new Date(Date.now() - STRANDED_AFTER_MS) } } },
    },
    select: { id: true },
  });
  for (const agent of stranded) {
    log.info({ agentId: agent.id }, 'Starting an agent for a message that was waiting');
    await ensureContainer(agent.id).catch((err: unknown) => log.warn({ agentId: agent.id, err }, 'Could not start the agent for its message'));
  }

  // An automatic agent left in "ready for review" (its delivery threw, e.g. a Docker timeout) holds its workflow step
  // forever: the delivery is tried again, at most every few minutes per agent.
  const now = Date.now();
  const undelivered = await prisma.agent.findMany({
    where: {
      autoConclude: true,
      status: 'READY_FOR_REVIEW',
      errorMessage: null,
      limitResumeAt: null,
      lastActivityAt: { lt: new Date(now - UNDELIVERED_AFTER_MS) },
    },
    select: { id: true },
  });
  for (const agent of undelivered) {
    if (now - (deliveryRetries.get(agent.id) ?? 0) < UNDELIVERED_AFTER_MS) continue;
    deliveryRetries.set(agent.id, now);
    log.info({ agentId: agent.id }, 'Delivering an automatic agent whose delivery had failed');
    await addEvent(agent.id, 'status', { message: 'A entrega não tinha terminado (ex.: o Docker demorou para responder): tentando de novo.' });
    await onAgentIdle(agent.id).catch((err: unknown) => log.warn({ agentId: agent.id, err }, 'Could not deliver the agent'));
  }
}

export function startAgentMonitor(log: FastifyBaseLogger) {
  limitRunningAgents()
    .then((result) => result.updated + result.failed > 0 && log.info(result, 'Resource limits applied to running agents'))
    .catch((err: unknown) => log.warn({ err }, 'Could not apply resource limits to running agents'));
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    checkContainers(log)
      .catch((err: unknown) => log.error({ err }, 'Agent monitor failed'))
      .finally(() => (running = false));
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
