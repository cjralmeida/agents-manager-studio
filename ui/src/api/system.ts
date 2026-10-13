import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type ContainerKind = 'studio' | 'agent';

export interface ContainerUsage {
  id: string;
  name: string;
  kind: ContainerKind;
  label: string;
  agentId: string | null;
  cpuPercent: number;
  memoryUsed: number;
}

/** The whole computer, measured on Windows by the Studio helper; null when the helper is not running. */
export interface HostStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  disks: { drive: string; total: number; free: number; agents: boolean }[];
  sampledAt: string;
}

export interface ResourceUsage {
  docker: { version: string; os: string; cpus: number; memoryTotal: number };
  host: HostStats | null;
  totals: { cpuPercent: number; memoryUsed: number; memoryPercent: number; runningAgents: number };
  limits: { memoryPercent: number; cpuPercent: number };
  launchWarnings: string[];
  containers: ContainerUsage[];
  sampledAt: string;
}

export interface DiskSummary {
  items: { label: string; bytes: number }[];
}

const scoped = (path: string, workspaceId?: string) => (workspaceId ? `${path}?workspaceId=${workspaceId}` : path);

/** Without a workspace: every Studio container; with one, only that workspace's agent containers. */
export function useResourceUsage(workspaceId?: string) {
  return useQuery({
    queryKey: ['system', 'resources', workspaceId ?? 'all'],
    queryFn: () => api.get<ResourceUsage>(scoped('/system/resources', workspaceId)),
    refetchInterval: 5_000,
  });
}

export function useDiskUsage(workspaceId?: string) {
  return useQuery({
    queryKey: ['system', 'disk', workspaceId ?? 'all'],
    queryFn: () => api.get<DiskSummary>(scoped('/system/disk', workspaceId)),
    refetchInterval: 120_000,
  });
}

/** Details sent with a 409 when launching while Docker usage is high. */
export function highUsageWarnings(details: unknown): string[] | null {
  if (details && typeof details === 'object' && 'code' in details && details.code === 'HIGH_USAGE' && 'warnings' in details) {
    return Array.isArray(details.warnings) ? details.warnings.map(String) : [];
  }
  return null;
}

export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
