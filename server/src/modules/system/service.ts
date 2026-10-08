import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { containerStats, diskUsage, dockerInfo, listRunningContainers } from '../../lib/docker.js';
import { AGENT_LABEL } from '../agents/runtime.js';
import { cpuPercent, launchWarnings, memoryUsed } from './usage.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const STUDIO_PROJECT = 'agents-manager-studio';

/** Stats take ~1s per sample; concurrent pollers share one sample for a few seconds. */
const RESOURCES_TTL_MS = 4_000;
const DISK_TTL_MS = 120_000;
let resourcesCache: { at: number; value: Promise<ResourceUsage> } | null = null;
let diskCache: { at: number; value: Promise<DiskSummary> } | null = null;

export type ContainerKind = 'studio' | 'agent' | 'other';

export interface ContainerUsage {
  id: string;
  name: string;
  kind: ContainerKind;
  /** Compose service, or the agent title for agent containers. */
  label: string;
  agentId: string | null;
  cpuPercent: number;
  memoryUsed: number;
}

export interface ResourceUsage {
  docker: { version: string; os: string; cpus: number; memoryTotal: number };
  totals: { cpuPercent: number; memoryUsed: number; memoryPercent: number; runningAgents: number };
  limits: { memoryPercent: number; cpuPercent: number };
  /** Reasons to confirm before launching another agent. */
  launchWarnings: string[];
  containers: ContainerUsage[];
  sampledAt: string;
}

export interface DiskSummary {
  images: number;
  containers: number;
  volumes: number;
  buildCache: number;
}

function kindOf(labels: Record<string, string>): ContainerKind {
  if (labels[AGENT_LABEL]) return 'agent';
  if (labels[COMPOSE_PROJECT_LABEL] === STUDIO_PROJECT) return 'studio';
  return 'other';
}

async function sampleResources(): Promise<ResourceUsage> {
  const [info, running] = await Promise.all([dockerInfo(), listRunningContainers()]);
  const agentIds = running.map((container) => container.Labels[AGENT_LABEL]).filter((id): id is string => Boolean(id));
  const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, title: true } });

  const containers = await Promise.all(
    running.map(async (container): Promise<ContainerUsage> => {
      const stats = await containerStats(container.Id).catch(() => null);
      const agentId = container.Labels[AGENT_LABEL] ?? null;
      const name = (container.Names[0] ?? container.Id).replace(/^\//, '');
      return {
        id: container.Id.slice(0, 12),
        name,
        kind: kindOf(container.Labels),
        label: agents.find((agent) => agent.id === agentId)?.title ?? container.Labels[COMPOSE_SERVICE_LABEL] ?? name,
        agentId,
        cpuPercent: stats ? cpuPercent(stats) : 0,
        memoryUsed: stats ? memoryUsed(stats) : 0,
      };
    }),
  );

  const cpuSum = containers.reduce((sum, container) => sum + container.cpuPercent, 0);
  const memorySum = containers.reduce((sum, container) => sum + container.memoryUsed, 0);
  const totals = {
    cpuPercent: cpuSum / Math.max(1, info.NCPU),
    memoryUsed: memorySum,
    memoryPercent: info.MemTotal > 0 ? (memorySum / info.MemTotal) * 100 : 0,
    runningAgents: containers.filter((container) => container.kind === 'agent').length,
  };
  const limits = { memoryPercent: config.launchMemoryPercent, cpuPercent: config.launchCpuPercent };

  return {
    docker: { version: info.ServerVersion, os: info.OperatingSystem, cpus: info.NCPU, memoryTotal: info.MemTotal },
    totals,
    limits,
    launchWarnings: launchWarnings(totals, limits),
    containers: containers.sort((a, b) => b.memoryUsed - a.memoryUsed),
    sampledAt: new Date().toISOString(),
  };
}

export function getResourceUsage(): Promise<ResourceUsage> {
  if (!resourcesCache || Date.now() - resourcesCache.at > RESOURCES_TTL_MS) {
    const value = sampleResources();
    resourcesCache = { at: Date.now(), value };
    // A failed sample must not be served from the cache.
    value.catch(() => {
      resourcesCache = null;
    });
  }
  return resourcesCache.value;
}

const sum = (values: (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

export function getDiskUsage(): Promise<DiskSummary> {
  if (!diskCache || Date.now() - diskCache.at > DISK_TTL_MS) {
    const value = diskUsage().then((df) => ({
      images: df.LayersSize ?? 0,
      containers: sum((df.Containers ?? []).map((container) => container.SizeRw)),
      volumes: sum((df.Volumes ?? []).map((volume) => volume.UsageData?.Size)),
      buildCache: sum((df.BuildCache ?? []).map((entry) => entry.Size)),
    }));
    diskCache = { at: Date.now(), value };
    value.catch(() => {
      diskCache = null;
    });
  }
  return diskCache.value;
}
