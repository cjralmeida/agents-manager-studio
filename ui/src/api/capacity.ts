import { useQuery } from '@tanstack/react-query';
import type { Proposal } from './assistant';
import { api } from './client';

export interface CapacitySummary {
  /** Changes to "Execuções ao mesmo tempo" waiting for the user (Órbi proposals). */
  suggestions: Proposal[];
  lastAnalysisAt: string | null;
  /** The Órbi conversation of the last analysis, with the reasoning. */
  lastConversationId: string | null;
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

/** Pending suggestions of every visible workspace, for the notice shown on every page. */
export function useCapacitySuggestions() {
  return useQuery({
    queryKey: ['capacity', 'suggestions'],
    queryFn: () => api.get<CapacitySuggestion[]>('/capacity/suggestions'),
    refetchInterval: 30_000,
  });
}
