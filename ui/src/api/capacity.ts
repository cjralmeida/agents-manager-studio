import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface CapacitySummary {
  /** A suggestion waiting for the user (raised while Órbi's pilot was off). */
  suggestions: { id: string; summary: string; createdAt: string }[];
  /** The last change raised: handed to the pilot, applied or discarded. */
  last: { at: string; status: 'pilot' | 'applied' | 'discarded'; summary: string } | null;
}

export function useCapacity(workspaceId: string) {
  return useQuery({
    queryKey: ['capacity', workspaceId],
    queryFn: () => api.get<CapacitySummary>(`/workspaces/${workspaceId}/capacity`),
    refetchInterval: 30_000,
  });
}

export interface CapacitySuggestion {
  id: string;
  summary: string;
  createdAt: string;
  workspaceId: string;
  workspaceName: string;
}

/** Pending suggestions of every visible workspace (the dot on the workspace in the menu). */
export function useCapacitySuggestions() {
  return useQuery({
    queryKey: ['capacity', 'suggestions'],
    queryFn: () => api.get<CapacitySuggestion[]>('/capacity/suggestions'),
    refetchInterval: 30_000,
  });
}

/** Applies a suggestion (each step gets its new number of agents) or discards it. */
export function useDecideCapacity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'apply' | 'discard' }) => api.post(`/capacity/suggestions/${id}/${decision}`),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}
