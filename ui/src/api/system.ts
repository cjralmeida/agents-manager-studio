import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type ContainerKind = 'studio' | 'agent' | 'other';

export interface ContainerUsage {
  id: string;
  name: string;
  kind: ContainerKind;
  label: string;
  agentId: string | null;
  cpuPercent: number;
  memoryUsed: number;
}

export interface ResourceUsage {
  docker: { version: string; os: string; cpus: number; memoryTotal: number };
  totals: { cpuPercent: number; memoryUsed: number; memoryPercent: number; runningAgents: number };
  limits: { memoryPercent: number; cpuPercent: number };
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

export function useResourceUsage() {
  return useQuery({
    queryKey: ['system', 'resources'],
    queryFn: () => api.get<ResourceUsage>('/system/resources'),
    refetchInterval: 5_000,
  });
}

export function useDiskUsage() {
  return useQuery({
    queryKey: ['system', 'disk'],
    queryFn: () => api.get<DiskSummary>('/system/disk'),
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
