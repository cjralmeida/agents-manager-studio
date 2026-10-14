import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface TestEnv {
  id: string;
  project: string;
  status: 'queued' | 'building' | 'ready' | 'failed' | 'stopped';
  commit: string | null;
  memoryMb: number;
  urls: { service: string; url: string }[];
  error: string | null;
  agentId: string | null;
  createdAt: string;
  readyAt: string | null;
}

export interface TestEnvSummary {
  environments: TestEnv[];
  /** How many more environments fit on the computer now (memory under the launch limit). */
  capacity: { active: number; fits: number; memoryMbPerEnv: number; limitPercent: number };
}

const key = ['test-envs'];

export function useTestEnvs() {
  return useQuery({ queryKey: key, queryFn: () => api.get<TestEnvSummary>('/test-envs'), refetchInterval: 15_000 });
}

export function useStopTestEnv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TestEnv>(`/test-envs/${id}/stop`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
