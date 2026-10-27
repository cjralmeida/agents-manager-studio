import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const SIZE_NAMES = ['P', 'M', 'G', 'GG'] as const;
export type SizeName = (typeof SIZE_NAMES)[number];

export interface AgentSize {
  name: string;
  cpus: number;
  /** Hard limit (MB): over it the container is killed and resumed one size up. */
  memoryMb: number;
  /** Counted for admission (MB). */
  reserveMb: number;
}

export interface ResourceSettings {
  sizes: Record<SizeName, AgentSize>;
  reservedCpus: number;
  reservedMemoryMb: number;
  cpuOvercommit: number;
}

export interface UsageStats {
  agents: number;
  p90PeakMemoryMb: number;
  maxPeakMemoryMb: number;
  /** 100 = one core. */
  p90AvgCpuPercent: number;
  p90PeakCpuPercent: number;
  ooms: number;
}

export type ResourceSuggestion =
  | {
      kind: 'reserve';
      size: SizeName;
      from: number;
      to: number;
      reason: string;
    }
  | { kind: 'memory'; size: SizeName; from: number; to: number; reason: string }
  | {
      kind: 'profile';
      profileId: string;
      profile: string;
      workspace: string;
      from: SizeName;
      to: SizeName;
      reason: string;
    };

export interface ResourceOverview {
  settings: ResourceSettings;
  machine: { cpus: number; memoryMb: number } | null;
  budget: { cpus: number; memoryMb: number } | null;
  reserved: { agents: number; cpus: number; memoryMb: number };
  sizes: (AgentSize & {
    name: SizeName;
    usage: UsageStats;
    suggestions: ResourceSuggestion[];
  })[];
  suggestions: ResourceSuggestion[];
  windowDays: number;
}

const key = ['resource-settings'] as const;

export function useResourceOverview() {
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<ResourceOverview>('/system/resource-settings'),
    refetchInterval: 30_000,
  });
}

export function useSaveResourceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: ResourceSettings) => api.put<ResourceOverview>('/system/resource-settings', settings),
    onSuccess: (overview) => queryClient.setQueryData(key, overview),
  });
}

export function useSetProfileSize() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, size }: { profileId: string; size: SizeName | null }) =>
      api.put<ResourceOverview>(`/system/resource-settings/profiles/${profileId}`, { size }),
    onSuccess: (overview) => queryClient.setQueryData(key, overview),
  });
}
