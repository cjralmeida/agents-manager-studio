import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
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

export const SIZE_NAMES = ['P', 'M', 'G', 'GG'] as const;
export type AgentSizeName = (typeof SIZE_NAMES)[number];

export const AGENT_SIZES: Record<AgentSizeName, AgentSize> = {
  P: { name: 'P', cpus: 1, memoryMb: 2048, reserveMb: 512 },
  M: { name: 'M', cpus: 2, memoryMb: 3072, reserveMb: 1536 },
  G: { name: 'G', cpus: 3, memoryMb: 5120, reserveMb: 2560 },
  // Only reached after an OOM in G (or set on a profile).
  GG: { name: 'GG', cpus: 4, memoryMb: 7168, reserveMb: 3584 },
};

/** One value per size, P to GG. */
export function mapSizes<T>(make: (name: AgentSizeName) => T): Record<AgentSizeName, T> {
  return Object.fromEntries(SIZE_NAMES.map((name) => [name, make(name)])) as Record<AgentSizeName, T>;
}

const isSizeName = (value: string | null | undefined): value is AgentSizeName => SIZE_NAMES.includes(value as AgentSizeName);

/** Sizes and machine budget, edited in Configurações → Recursos (defaults: the constants above and .env). */
export interface ResourceSettings {
  sizes: Record<AgentSizeName, AgentSize>;
  /** CPUs and memory (MB) of Docker kept for the Studio and its services. */
  reservedCpus: number;
  reservedMemoryMb: number;
  /** Agent CPU reservations may add up to this many times the CPUs left (they mostly wait for the model). */
  cpuOvercommit: number;
}

const SETTINGS_KEY = 'resources';
const SETTINGS_TTL_MS = 15_000;
let settingsCache: { at: number; value: ResourceSettings } | null = null;

export function defaultResourceSettings(): ResourceSettings {
  return {
    sizes: structuredClone(AGENT_SIZES),
    reservedCpus: config.machineReservedCpus,
    reservedMemoryMb: config.machineReservedMemoryMb,
    cpuOvercommit: config.agentCpuOvercommit,
  };
}

/** What is saved over the defaults (a size or field left out keeps its default). */
export function mergeSettings(saved: Partial<ResourceSettings> | null): ResourceSettings {
  const defaults = defaultResourceSettings();
  if (!saved) return defaults;
  return {
    sizes: mapSizes((name) => ({ ...defaults.sizes[name], ...saved.sizes?.[name], name })),
    reservedCpus: saved.reservedCpus ?? defaults.reservedCpus,
    reservedMemoryMb: saved.reservedMemoryMb ?? defaults.reservedMemoryMb,
    cpuOvercommit: saved.cpuOvercommit ?? defaults.cpuOvercommit,
  };
}

export async function getResourceSettings(): Promise<ResourceSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const row = await prisma.studioSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const value = mergeSettings((row?.value as Partial<ResourceSettings> | undefined) ?? null);
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves the settings and applies the new limits to the agents already running. */
export async function saveResourceSettings(value: ResourceSettings) {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: json }, update: { value: json } });
  settingsCache = null;
  await limitRunningAgents().catch(() => undefined);
  return getResourceSettings();
}

/** Roles that compile and test a backend (Maven, Spring, e2e) and the ones that build a front or drive a browser. */
const LARGE_ROLES = ['backend-builder', 'code-guardian'];
const MEDIUM_ROLES = ['frontend-builder', 'frontend-guardian', 'hom-screen-ranger', 'hom-ranger', 'hom-api-ranger', 'play-tester', 'game-builder'];

const names = (text: string, role: string) => new RegExp(`(^|[^\\w-])${role}($|[^\\w-])`).test(text);

export interface SizedProfile {
  name: string;
  instructions: string;
  /** Size chosen in Configurações → Recursos; null: by role. */
  resourceSize?: string | null;
}

/** The size of a profile's role (the skill it names), ignoring a size chosen for it. */
export function roleSizeName(profile: Pick<SizedProfile, 'name' | 'instructions'> | null): AgentSizeName {
  if (!profile) return 'M';
  const text = `${profile.name} ${profile.instructions}`;
  if (LARGE_ROLES.some((role) => names(text, role))) return 'G';
  if (MEDIUM_ROLES.some((role) => names(text, role))) return 'M';
  return 'P';
}

/**
 * The size of an agent: the one it was moved to after running out of memory, else the one chosen for its profile,
 * else by its role. Órbi and roles that only read and write text (spec, tasks, roadmap, publishing) are small.
 */
export function agentSizeName(agent: { kind: string; resourceSize?: string | null }, profile: SizedProfile | null): AgentSizeName {
  if (isSizeName(agent.resourceSize)) return agent.resourceSize;
  if (agent.kind !== 'TASK') return 'P';
  if (isSizeName(profile?.resourceSize)) return profile.resourceSize;
  return roleSizeName(profile);
}

const PROFILE_SIZE_SELECT = { name: true, instructions: true, resourceSize: true } as const;

/** The size of a saved agent (its profile read for the role). */
export async function sizeOfAgent(agent: { kind: string; resourceSize: string | null; profileId: string | null }): Promise<AgentSize> {
  const profile = agent.profileId ? await prisma.agentProfile.findUnique({ where: { id: agent.profileId }, select: PROFILE_SIZE_SELECT }) : null;
  return (await getResourceSettings()).sizes[agentSizeName(agent, profile)];
}

/** The size of the agent a workflow step starts with this profile. */
export async function sizeOfProfile(profileId: string): Promise<AgentSize> {
  const profile = await prisma.agentProfile.findUnique({ where: { id: profileId }, select: PROFILE_SIZE_SELECT });
  return (await getResourceSettings()).sizes[agentSizeName({ kind: 'TASK' }, profile)];
}

const RUNNING_SELECT = { id: true, containerId: true, kind: true, resourceSize: true, profile: { select: PROFILE_SIZE_SELECT } } as const;

/** Sizes of the agents whose container is up (or starting): what is reserved now. */
export async function runningSizes(): Promise<AgentSize[]> {
  const [agents, settings] = await Promise.all([prisma.agent.findMany({ where: { containerId: { not: null } }, select: RUNNING_SELECT }), getResourceSettings()]);
  return agents.map((agent) => settings.sizes[agentSizeName(agent, agent.profile)]);
}

/**
 * Containers started before the limits existed (or before they changed) get them while they run. A memory limit below
 * what the container already uses is refused by Docker: that one keeps going and gets it on its next start.
 */
export async function limitRunningAgents(): Promise<{ updated: number; failed: number }> {
  const [agents, settings] = await Promise.all([prisma.agent.findMany({ where: { containerId: { not: null } }, select: RUNNING_SELECT }), getResourceSettings()]);
  let updated = 0;
  let failed = 0;
  for (const agent of agents) {
    const size = settings.sizes[agentSizeName(agent, agent.profile)];
    const ok = await updateContainer(agent.containerId!, hostLimits(size)).then(
      () => true,
      () => false,
    );
    if (!ok) {
      failed++;
      continue;
    }
    updated++;
    await prisma.agent.update({ where: { id: agent.id }, data: { sizeName: size.name } }).catch(() => undefined);
  }
  return { updated, failed };
}

/** The next size after an OOM; null when it is already the largest. */
export function largerSize(size: string): AgentSizeName | null {
  const index = SIZE_NAMES.indexOf(size as AgentSizeName);
  return index === -1 ? null : (SIZE_NAMES[index + 1] ?? null);
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

/** Docker's CPUs and memory (MB). */
export async function machineSize(): Promise<Budget | null> {
  const info = await dockerInfo().catch(() => null);
  if (!info || !info.NCPU || !info.MemTotal) return null;
  return { cpus: info.NCPU, memoryMb: info.MemTotal / 1024 / 1024 };
}

/** What agents may reserve: Docker's CPUs and memory minus what the Studio and its services keep. */
export function budgetOf(machine: Budget, settings: ResourceSettings): Budget {
  return {
    cpus: Math.max(1, machine.cpus - settings.reservedCpus) * settings.cpuOvercommit,
    memoryMb: Math.max(1024, machine.memoryMb - settings.reservedMemoryMb),
  };
}

export async function machineBudget(): Promise<Budget | null> {
  const machine = await machineSize();
  return machine && budgetOf(machine, await getResourceSettings());
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

// ---------------------------------------------------------------- measured usage

const USAGE_EVERY_MS = 60_000;
let lastUsageAt = 0;

/**
 * Keeps each agent's peak memory and CPU and its average CPU, from the samples the Studio already takes of the
 * containers (at most once a minute): the Gestor de Capacidade compares them with the sizes.
 */
export async function recordAgentUsage(samples: { agentId: string | null; cpuPercent: number; memoryUsed: number }[]) {
  if (Date.now() - lastUsageAt < USAGE_EVERY_MS) return;
  lastUsageAt = Date.now();
  for (const sample of samples) {
    if (!sample.agentId) continue;
    const memoryMb = Math.round(sample.memoryUsed / 1024 / 1024);
    await prisma.$executeRaw`
      UPDATE "agents" SET
        "peak_memory_mb" = GREATEST(COALESCE("peak_memory_mb", 0), ${memoryMb}),
        "peak_cpu_percent" = GREATEST(COALESCE("peak_cpu_percent", 0), ${sample.cpuPercent}),
        "cpu_percent_sum" = "cpu_percent_sum" + ${sample.cpuPercent},
        "usage_samples" = "usage_samples" + 1
      WHERE "id" = ${sample.agentId}::uuid`;
  }
}
