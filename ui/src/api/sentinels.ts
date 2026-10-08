import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentModel } from './agents';
import { api } from './client';

export interface Sentinel {
  id: string;
  workspaceId: string;
  name: string;
  isEnabled: boolean;
  fieldFilters: Record<string, string[]>;
  repositories: string[];
  columnId: string | null;
  onlyUnassigned: boolean;
  instructions: string;
  model: AgentModel;
  maxConcurrent: number;
  lastCheckedAt: string | null;
  lastLaunchAt: string | null;
  statusMessage: string | null;
  workingAgents: number;
  totalAgents: number;
  createdAt: string;
}

export type SentinelInput = Pick<
  Sentinel,
  'name' | 'isEnabled' | 'fieldFilters' | 'repositories' | 'columnId' | 'onlyUnassigned' | 'instructions' | 'model' | 'maxConcurrent'
>;

const keys = {
  list: (workspaceId: string) => ['sentinels', workspaceId] as const,
};

export function useSentinels(workspaceId: string) {
  return useQuery({
    queryKey: keys.list(workspaceId),
    queryFn: () => api.get<Sentinel[]>(`/workspaces/${workspaceId}/sentinels`),
    refetchInterval: 15_000,
  });
}

function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.list(workspaceId) });
    // A run may launch agents and move cards.
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
    void queryClient.invalidateQueries({ queryKey: ['board', workspaceId] });
  };
}

export function useCreateSentinel(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: SentinelInput) => api.post<Sentinel>(`/workspaces/${workspaceId}/sentinels`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateSentinel(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<SentinelInput> & { id: string }) => api.patch<Sentinel>(`/sentinels/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSentinel(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/sentinels/${id}`), onSuccess: invalidate });
}

export function useRunSentinel(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.post<Sentinel>(`/sentinels/${id}/run`), onSuccess: invalidate });
}
