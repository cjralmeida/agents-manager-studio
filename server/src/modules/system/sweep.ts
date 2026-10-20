import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { AgentStatus } from '../../generated/prisma/client.js';
import { listAllContainers, listVolumes, removeContainer, removeVolume } from '../../lib/docker.js';
import { AGENT_LABEL } from '../agents/runtime.js';

/**
 * Keeps Docker light: what agents leave behind piles up (containers that stopped, died or never started, the volume of
 * each finished agent) and slows every Docker call down. Runs every hour; it never touches a working agent, the
 * Studio's own services or anything that is not the Studio's.
 */

const SWEEP_MS = 60 * 60_000;
/** Agents still using their container and volume. */
const ACTIVE: AgentStatus[] = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING'];
/** A finished agent keeps its volume (its Claude session) this long, in case someone sends it a message. */
const VOLUME_KEEP_MS = 3 * 24 * 3600_000;
const AGENT_VOLUME = /^ams-agent-([0-9a-f-]{36})$/;
const ANONYMOUS_KEEP_MS = 24 * 3600_000;

export async function sweepDocker(log?: FastifyBaseLogger) {
  // 1. Agent containers that are not running (exited, dead, created after a timeout) of agents that are not working.
  const containers = await listAllContainers(`{"label":["${AGENT_LABEL}"]}`);
  const idle = containers.filter((container) => container.State !== 'running');
  const agentIds = [...new Set(idle.map((container) => container.Labels[AGENT_LABEL]).filter((id): id is string => Boolean(id)))];
  const working = new Set(
    (await prisma.agent.findMany({ where: { id: { in: agentIds }, status: { in: ACTIVE }, containerId: { not: null } }, select: { id: true } })).map((agent) => agent.id),
  );
  let containersRemoved = 0;
  for (const container of idle) {
    if (working.has(container.Labels[AGENT_LABEL]!) && container.State !== 'dead') continue;
    await removeContainer(container.Id).then(() => containersRemoved++).catch(() => undefined);
  }

  // 2. Volumes of agents that finished days ago (or no longer exist).
  const volumes = (await listVolumes()).map((volume) => ({ name: volume.Name, id: AGENT_VOLUME.exec(volume.Name)?.[1] })).filter((volume) => volume.id);
  const agents = await prisma.agent.findMany({ where: { id: { in: volumes.map((volume) => volume.id!) } }, select: { id: true, status: true, finishedAt: true, updatedAt: true } });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let volumesRemoved = 0;
  for (const volume of volumes) {
    const agent = byId.get(volume.id!);
    const finishedLongAgo = agent && !ACTIVE.includes(agent.status) && Date.now() - (agent.finishedAt ?? agent.updatedAt).getTime() > VOLUME_KEEP_MS;
    if (agent && !finishedLongAgo) continue;
    // In use (a container still mounts it) → Docker refuses; it goes in a later sweep.
    await removeVolume(volume.name).then(() => volumesRemoved++).catch(() => undefined);
  }
  // 3. Anonymous volumes no container uses (left by containers removed without them), after a day: nothing can mount
  // an anonymous volume again by name, so they are only garbage.
  const orphans = await listVolumes('{"dangling":["true"],"label":["com.docker.volume.anonymous"]}');
  let anonymousRemoved = 0;
  for (const volume of orphans) {
    if (volume.CreatedAt && Date.now() - Date.parse(volume.CreatedAt) < ANONYMOUS_KEEP_MS) continue;
    await removeVolume(volume.Name).then(() => anonymousRemoved++).catch(() => undefined);
  }
  if (containersRemoved + volumesRemoved + anonymousRemoved > 0) log?.info({ containersRemoved, volumesRemoved, anonymousRemoved }, 'Docker sweep');
  return { containersRemoved, volumesRemoved, anonymousRemoved };
}

export function startDockerSweep(log: FastifyBaseLogger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    await sweepDocker(log)
      .catch((err: unknown) => log.warn({ err }, 'Docker sweep failed'))
      .finally(() => (running = false));
  };
  const first = setTimeout(() => void tick(), 2 * 60_000);
  const timer = setInterval(() => void tick(), SWEEP_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
