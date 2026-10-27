import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { dockerInfo, updateContainer } from '../../lib/docker.js';

/**
 * Resources of an agent container, by the weight of its role. The limit is hard (the container never takes more); the
 * reservation is what admission counts, so the sum of what is running never goes past the machine's budget.
 */
export interface AgentSize {
  name: string;
  cpus: number;
  /** Hard memory limit (MB): over it the container is killed (OOM, code 137) and started again one size up. */
  memoryMb: number;
  /** Memory counted for admission (MB): what the role usually uses at its peaks (measured on 27/10: 0.2–1.5 GB). */
  reserveMb: number;
}

export const AGENT_SIZES = {
  P: { name: 'P', cpus: 1, memoryMb: 2048, reserveMb: 512 },
  M: { name: 'M', cpus: 2, memoryMb: 3072, reserveMb: 1536 },
  G: { name: 'G', cpus: 3, memoryMb: 5120, reserveMb: 2560 },
  // Only reached after an OOM in G.
  GG: { name: 'GG', cpus: 4, memoryMb: 7168, reserveMb: 3584 },
} satisfies Record<string, AgentSize>;

export type AgentSizeName = keyof typeof AGENT_SIZES;

const ORDER: AgentSizeName[] = ['P', 'M', 'G', 'GG'];

/** Roles that compile and test a backend (Maven, Spring, e2e) and the ones that build a front or drive a browser. */
const LARGE_ROLES = ['backend-builder', 'code-guardian'];
const MEDIUM_ROLES = ['frontend-builder', 'frontend-guardian', 'hom-screen-ranger', 'hom-ranger', 'hom-api-ranger', 'play-tester', 'game-builder'];

const names = (text: string, role: string) => new RegExp(`(^|[^\\w-])${role}($|[^\\w-])`).test(text);

/**
 * The size of an agent: the one it was moved to after running out of memory, else by its role (the skill named by its
 * profile). Órbi and roles that only read and write text (spec, tasks, roadmap, publishing) are small.
 */
export function agentSizeName(agent: { kind: string; resourceSize?: string | null }, profile: { name: string; instructions: string } | null): AgentSizeName {
  if (agent.resourceSize && agent.resourceSize in AGENT_SIZES) return agent.resourceSize as AgentSizeName;
  if (agent.kind !== 'TASK') return 'P';
  if (!profile) return 'M';
  const text = `${profile.name} ${profile.instructions}`;
  if (LARGE_ROLES.some((role) => names(text, role))) return 'G';
  if (MEDIUM_ROLES.some((role) => names(text, role))) return 'M';
  return 'P';
}

/** The size of a saved agent (its profile read for the role). */
export async function sizeOfAgent(agent: { kind: string; resourceSize: string | null; profileId: string | null }): Promise<AgentSize> {
  const profile = agent.profileId ? await prisma.agentProfile.findUnique({ where: { id: agent.profileId }, select: { name: true, instructions: true } }) : null;
  return AGENT_SIZES[agentSizeName(agent, profile)];
}

/** Sizes of the agents whose container is up (or starting): what is reserved now. */
export async function runningSizes(): Promise<AgentSize[]> {
  const agents = await prisma.agent.findMany({
    where: { containerId: { not: null } },
    select: { kind: true, resourceSize: true, profile: { select: { name: true, instructions: true } } },
  });
  return agents.map((agent) => AGENT_SIZES[agentSizeName(agent, agent.profile)]);
}

/**
 * Containers started before the limits existed (or before a Studio update) get them while they run. A memory limit
 * below what the container already uses is refused by Docker: that one keeps going and gets it on its next start.
 */
export async function limitRunningAgents(): Promise<{ updated: number; failed: number }> {
  const agents = await prisma.agent.findMany({
    where: { containerId: { not: null } },
    select: { containerId: true, kind: true, resourceSize: true, profile: { select: { name: true, instructions: true } } },
  });
  let updated = 0;
  let failed = 0;
  for (const agent of agents) {
    const ok = await updateContainer(agent.containerId!, hostLimits(AGENT_SIZES[agentSizeName(agent, agent.profile)])).then(
      () => true,
      () => false,
    );
    if (ok) updated++;
    else failed++;
  }
  return { updated, failed };
}

/** The next size after an OOM; null when it is already the largest. */
export function largerSize(size: AgentSizeName): AgentSizeName | null {
  return ORDER[ORDER.indexOf(size) + 1] ?? null;
}

/** Docker HostConfig for a size: CPU and memory caps, and a lower CPU weight than the Studio and its databases. */
export function hostLimits(size: AgentSize, cpuWeight = AGENT_CPU_SHARES) {
  return {
    NanoCpus: Math.round(size.cpus * 1e9),
    Memory: size.memoryMb * 1024 * 1024,
    // Same as Memory: no swap beyond the limit (a swapping agent slows the whole VM down).
    MemorySwap: size.memoryMb * 1024 * 1024,
    MemoryReservation: size.reserveMb * 1024 * 1024,
    CpuShares: cpuWeight,
    PidsLimit: 4096,
  };
}

/** Preview builds and apps (Rodar): enough for a Vite build or a Spring app, below any agent in CPU weight. */
export const PREVIEW_SIZE: AgentSize = { name: 'preview', cpus: 2, memoryMb: 3072, reserveMb: 1024 };

/** Under contention the Studio, Postgres and the proxy (1024, Docker's default) get the CPU before agents and previews. */
export const AGENT_CPU_SHARES = 512;
export const PREVIEW_CPU_SHARES = 256;

/** Test workers of a container: never more than its CPUs (nor the configured maximum). */
export function testWorkers(size: AgentSize) {
  return Math.max(1, Math.min(config.agentTestWorkers, Math.floor(size.cpus)));
}

/**
 * JVM and Node inside the container follow its memory: the JVM already reads the cgroup limit, but its default heap
 * (25%) is too small for a Maven build plus forked tests; Node's default old space ignores the limit on some versions.
 */
export function runtimeEnv(size: AgentSize): Record<string, string> {
  return {
    VITEST_MAX_WORKERS: String(testWorkers(size)),
    MAVEN_OPTS: '-XX:MaxRAMPercentage=35',
    STUDIO_AGENT_SIZE: size.name,
    STUDIO_AGENT_CPUS: String(size.cpus),
    STUDIO_AGENT_MEMORY_MB: String(size.memoryMb),
  };
}

export interface Budget {
  cpus: number;
  memoryMb: number;
}

/** What agents may reserve: Docker's CPUs and memory minus what the Studio and its services keep. */
export async function machineBudget(): Promise<Budget | null> {
  const info = await dockerInfo().catch(() => null);
  if (!info || !info.NCPU || !info.MemTotal) return null;
  return {
    cpus: Math.max(1, info.NCPU - config.machineReservedCpus) * config.agentCpuOvercommit,
    memoryMb: Math.max(1024, info.MemTotal / 1024 / 1024 - config.machineReservedMemoryMb),
  };
}

/**
 * Whether one more agent of this size fits next to the running ones; the reason when it does not. CPU is
 * overcommitted (agents spend most of their time waiting for the model), memory is not.
 */
export function admission(running: AgentSize[], size: AgentSize, budget: Budget): string | null {
  const cpus = running.reduce((sum, item) => sum + item.cpus, 0);
  const memoryMb = running.reduce((sum, item) => sum + item.reserveMb, 0);
  const gb = (mb: number) => (mb / 1024).toFixed(1).replace('.0', '');
  if (memoryMb + size.reserveMb > budget.memoryMb) {
    return `Aguardando: memória reservada ${gb(memoryMb)}/${gb(budget.memoryMb)} GB (agente ${size.name} precisa de ${gb(size.reserveMb)} GB).`;
  }
  if (cpus + size.cpus > budget.cpus) {
    return `Aguardando: CPU reservada ${cpus}/${Math.floor(budget.cpus)} vCPU (agente ${size.name} precisa de ${size.cpus}).`;
  }
  return null;
}
