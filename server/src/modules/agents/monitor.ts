import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { containerLogs, inspectContainer, removeContainer } from '../../lib/docker.js';
import { addEvent, ensureContainer, markFailed } from './service.js';

const INTERVAL_MS = 5_000;

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

    if (exitCode !== 0) {
      const tail = logs ? `${logs.stderr}\n${logs.stdout}`.trim().slice(-800) : '';
      log.warn({ agentId: agent.id, exitCode }, 'Agent container stopped unexpectedly');
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
}

export function startAgentMonitor(log: FastifyBaseLogger) {
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
