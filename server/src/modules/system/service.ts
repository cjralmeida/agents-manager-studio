import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { containerStats, diskUsage, dockerInfo, listRunningContainers } from '../../lib/docker.js';
import { notFound } from '../../lib/errors.js';
import { AGENT_LABEL, agentVolumeName } from '../agents/runtime.js';
import { cpuPercent, launchWarnings, memoryUsed } from './usage.js';

const execFileAsync = promisify(execFile);

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const STUDIO_PROJECT = 'agents-manager-studio';

/** Stats take ~1s per sample; concurrent pollers share one sample for a few seconds. */
const RESOURCES_TTL_MS = 4_000;
const DISK_TTL_MS = 120_000;
let resourcesCache: { at: number; value: Promise<ResourceUsage> } | null = null;
/** Docker can stop answering for a while under load; the last good sample is used up to this long. */
const STALE_MAX_MS = 5 * 60_000;
let lastGoodResources: ResourceUsage | null = null;
let diskCache: { at: number; value: Promise<RawDisk> } | null = null;
const folderSizeCache = new Map<string, { at: number; value: Promise<number> }>();
type RawDisk = Awaited<ReturnType<typeof diskUsage>>;

/** Only Studio containers are measured: the compose services and the agent containers. */
export type ContainerKind = 'studio' | 'agent';

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

/** The whole computer, measured on Windows by the helper (studio.ps1); null when the helper is not running. */
export interface HostStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  /** Fixed disks, with the one holding the agent copies marked. */
  disks: { drive: string; total: number; free: number; agents: boolean }[];
  /** Docker's virtual disk file on Windows, when the helper finds it. */
  dockerDisk?: { path: string; size: number } | null;
  sampledAt: string;
}

export interface ResourceUsage {
  docker: { version: string; os: string; cpus: number; memoryTotal: number };
  host: HostStats | null;
  totals: { cpuPercent: number; memoryUsed: number; memoryPercent: number; runningAgents: number };
  limits: { memoryPercent: number; cpuPercent: number };
  /** Reasons to confirm before launching another agent. */
  launchWarnings: string[];
  containers: ContainerUsage[];
  sampledAt: string;
  /** Docker did not answer: the Docker part is the last good sample (sampledAt), the host part is fresh. */
  stale?: boolean;
}

export interface DiskSummary {
  items: { label: string; bytes: number }[];
  /**
   * Docker's virtual disk on Windows (it grows and only gives space back when compacted) next to what Docker really
   * keeps in it; only for the whole Studio, when the Windows helper measures it.
   */
  dockerDisk?: { path: string; fileBytes: number; dataBytes: number } | null;
}

function kindOf(labels: Record<string, string> | null | undefined): ContainerKind | null {
  if (labels?.[AGENT_LABEL]) return 'agent';
  if (labels?.[COMPOSE_PROJECT_LABEL] === STUDIO_PROJECT) return 'studio';
  return null;
}

async function sampleResources(): Promise<ResourceUsage> {
  const [info, all] = await Promise.all([dockerInfo(), listRunningContainers()]);
  const running = all.filter((container) => kindOf(container.Labels) !== null);
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
        kind: kindOf(container.Labels)!,
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
  const limits = { memoryPercent: config.launchMemoryPercent, cpuPercent: config.launchCpuPercent, minFreeDiskGb: config.minFreeDiskGb };
  const host = await readHostStats();
  const agentsDisk = host?.disks.find((disk) => disk.agents);
  const freeDiskGb = agentsDisk ? agentsDisk.free / 1024 ** 3 : await freeAgentsDiskGb();
  // The launch limits look at the whole computer when the helper measures it: the agents compete with everything else.
  const launchTotals = host
    ? { memoryPercent: host.memoryPercent, cpuPercent: host.cpuPercent, freeDiskGb, source: 'host' as const }
    : { ...totals, freeDiskGb };

  return {
    docker: { version: info.ServerVersion, os: info.OperatingSystem, cpus: info.NCPU, memoryTotal: info.MemTotal },
    totals,
    limits,
    host,
    launchWarnings: launchWarnings(launchTotals, limits),
    containers: containers.sort((a, b) => b.memoryUsed - a.memoryUsed),
    sampledAt: new Date().toISOString(),
  };
}

const HOST_STATS_STALE_MS = 30_000;

/** Host numbers written by the Windows helper into helper.json; null when the helper is off or the sample is old. */
async function readHostStats(): Promise<HostStats | null> {
  try {
    const state = JSON.parse((await readFile(path.join(config.hostHelperDir, 'helper.json'), 'utf8')).replace(/^﻿/, '')) as {
      host?: { cpuPercent: number; memoryUsed: number; memoryTotal: number; disks?: { drive: string; total: number; free: number }[]; dockerDisk?: { path: string; size: number } | null; sampledAt: string } | null;
    };
    const host = state.host;
    if (!host || Date.now() - new Date(host.sampledAt).getTime() > HOST_STATS_STALE_MS) return null;
    const agentsDrive = config.agentsHostDir.slice(0, 2).toUpperCase();
    return {
      cpuPercent: host.cpuPercent,
      memoryUsed: host.memoryUsed,
      memoryTotal: host.memoryTotal,
      memoryPercent: host.memoryTotal > 0 ? (host.memoryUsed / host.memoryTotal) * 100 : 0,
      disks: (host.disks ?? []).map((disk) => ({ ...disk, agents: disk.drive.toUpperCase() === agentsDrive })),
      dockerDisk: host.dockerDisk ?? null,
      sampledAt: host.sampledAt,
    };
  } catch {
    return null;
  }
}

/** Free space (GB) on the disk that holds the agent copies; null when it cannot be read. */
export async function freeAgentsDiskGb() {
  try {
    const stats = await statfs(config.agentsDir);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

/**
 * When Docker does not answer (a busy machine: exactly when the limits matter), the last good sample stands in for a
 * few minutes with the computer's numbers read fresh from the helper, instead of everyone getting nothing.
 */
async function staleSample(error: unknown): Promise<ResourceUsage> {
  const last = lastGoodResources;
  if (!last || Date.now() - Date.parse(last.sampledAt) > STALE_MAX_MS) throw error;
  return { ...last, host: (await readHostStats()) ?? last.host, stale: true };
}

export function getResourceUsage(): Promise<ResourceUsage> {
  if (!resourcesCache || Date.now() - resourcesCache.at > RESOURCES_TTL_MS) {
    const value = sampleResources().then(
      (usage) => (lastGoodResources = usage),
      (error: unknown) => staleSample(error),
    );
    resourcesCache = { at: Date.now(), value };
    // A failed sample must not be served from the cache.
    value.catch(() => {
      resourcesCache = null;
    });
  }
  return resourcesCache.value;
}

const sum = (values: (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** Disk of the Studio only: images used by its containers (plus the agent image), their layers and volumes. */
function studioDisk(df: RawDisk): DiskSummary {
  const containers = (df.Containers ?? []).filter((container) => kindOf(container.Labels) !== null);
  const imageIds = new Set(containers.map((container) => container.ImageID));
  const images = (df.Images ?? []).filter(
    (image) => imageIds.has(image.Id) || image.RepoTags?.includes(config.agentRunnerImage),
  );
  const agentVolumePrefix = agentVolumeName('');
  const volumes = (df.Volumes ?? []).filter(
    (volume) => volume.Name.startsWith(agentVolumePrefix) || volume.Labels?.[COMPOSE_PROJECT_LABEL] === STUDIO_PROJECT,
  );
  return {
    items: [
      { label: 'Imagens', bytes: sum(images.map((image) => image.Size)) },
      { label: 'Volumes', bytes: sum(volumes.map((volume) => volume.UsageData?.Size)) },
      { label: 'Containers', bytes: sum(containers.map((container) => container.SizeRw)) },
    ],
  };
}

function rawDisk(): Promise<RawDisk> {
  if (!diskCache || Date.now() - diskCache.at > DISK_TTL_MS) {
    const value = diskUsage();
    diskCache = { at: Date.now(), value };
    value.catch(() => {
      diskCache = null;
    });
  }
  return diskCache.value;
}

/** Everything Docker keeps: image layers, containers, volumes and the build cache. */
function dockerDataBytes(df: RawDisk) {
  return (
    (df.LayersSize ?? 0) +
    sum((df.Containers ?? []).map((container) => container.SizeRw)) +
    sum((df.Volumes ?? []).map((volume) => volume.UsageData?.Size)) +
    sum((df.BuildCache ?? []).map((entry) => entry.Size))
  );
}

export async function getDiskUsage(): Promise<DiskSummary> {
  const [df, host] = await Promise.all([rawDisk(), readHostStats()]);
  const file = host?.dockerDisk;
  return { ...studioDisk(df), dockerDisk: file ? { path: file.path, fileBytes: file.size, dataBytes: dockerDataBytes(df) } : null };
}

// ---------------------------------------------------------------- per workspace

/** The Studio sample restricted to the agent containers of one workspace (shared services are left out). */
export async function getWorkspaceResourceUsage(workspaceId: string): Promise<ResourceUsage> {
  const [usage, agents] = await Promise.all([
    getResourceUsage(),
    prisma.agent.findMany({ where: { workspaceId }, select: { id: true } }),
  ]);
  const ids = new Set(agents.map((agent) => agent.id));
  const containers = usage.containers.filter((container) => container.agentId && ids.has(container.agentId));
  const memoryUsed = containers.reduce((total, container) => total + container.memoryUsed, 0);
  const cpuSum = containers.reduce((total, container) => total + container.cpuPercent, 0);
  return {
    ...usage,
    containers,
    totals: {
      cpuPercent: cpuSum / Math.max(1, usage.docker.cpus),
      memoryUsed,
      memoryPercent: usage.docker.memoryTotal > 0 ? (memoryUsed / usage.docker.memoryTotal) * 100 : 0,
      runningAgents: containers.length,
    },
  };
}

/** Size of a folder in bytes (GNU du), cached because large clones take a while to walk. */
function folderSize(dir: string): Promise<number> {
  const cached = folderSizeCache.get(dir);
  if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached.value;
  const value = execFileAsync('du', ['-sb', dir], { timeout: 60_000 })
    .then(({ stdout }) => Number(stdout.trim().split(/\s+/)[0]) || 0)
    .catch(() => 0);
  folderSizeCache.set(dir, { at: Date.now(), value });
  return value;
}

/** Disk a workspace uses: its agents' project clones and their Claude session volumes. */
export async function getWorkspaceDiskUsage(workspaceId: string): Promise<DiskSummary> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, agents: { select: { id: true } } },
  });
  if (!workspace) throw notFound('Workspace não encontrado.');

  const volumeNames = new Set(workspace.agents.map((agent) => agentVolumeName(agent.id)));
  const [df, clones] = await Promise.all([rawDisk(), folderSize(path.posix.join(config.agentsDir, workspace.name))]);
  const sessions = (df.Volumes ?? []).filter((volume) => volumeNames.has(volume.Name));
  return {
    items: [
      { label: 'Cópias dos projetos', bytes: clones },
      { label: 'Sessões dos agentes', bytes: sum(sessions.map((volume) => volume.UsageData?.Size)) },
    ],
  };
}
