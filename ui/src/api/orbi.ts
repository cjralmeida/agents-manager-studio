import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentQuestion } from './agents';
import { api } from './client';

export interface OrbiActivity {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  conversationId: string | null;
  kind: 'answer' | 'message' | 'task' | 'workflow' | 'pause' | 'resume' | 'capacity' | 'conflict' | 'flag';
  summary: string;
  details: Record<string, unknown> | null;
  link: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface OrbiPending {
  questions: { agentId: string; title: string; workspaceId: string; task: string | null; waitingSince: string; questions: AgentQuestion[] }[];
  failedRuns: { runId: string; workflow: string; title: string; workspaceId: string; error: string | null; executionId: string | null; finishedAt: string }[];
  capacitySuggestions: { proposalId: string; summary: string; workspaceId: string; createdAt: string }[];
  proposals: { id: string; summary: string; kind: string; agentId: string; workspaceId: string; createdAt: string }[];
  flags: OrbiActivity[];
  workspaces: { id: string; name: string }[];
}

export type PilotKind = 'tasks' | 'agents';

export interface PilotSettings {
  enabled: boolean;
  allWorkspaces: boolean;
  workspaceIds: string[];
  model: 'sonnet' | 'opus';
  /** technical: the user is around (only technical problems); full: the user is away (everything). */
  mode: 'technical' | 'full';
  instructions: string;
  conversationId: string | null;
  lastEventAt: string | null;
}

const keys = {
  pending: ['orbi', 'pending'] as const,
  activity: ['orbi', 'activity'] as const,
  pilots: ['orbi', 'pilots'] as const,
};

export function useOrbiPending() {
  return useQuery({ queryKey: keys.pending, queryFn: () => api.get<OrbiPending>('/orbi/pending'), refetchInterval: 15_000 });
}

export function useOrbiActivity(limit = 60) {
  return useQuery({ queryKey: [...keys.activity, limit], queryFn: () => api.get<OrbiActivity[]>(`/orbi/activity?limit=${limit}`), refetchInterval: 15_000 });
}

export function useResolveFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<OrbiActivity>(`/orbi/flags/${id}/resolve`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.pending });
      void queryClient.invalidateQueries({ queryKey: keys.activity });
    },
  });
}

/** Failures marked as seen leave the list: some runs, or (no runIds) everything up to now, flags included. */
export function useMarkSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runIds?: string[]) => api.post('/orbi/pending/seen', runIds ? { runIds } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.pending });
      void queryClient.invalidateQueries({ queryKey: keys.activity });
    },
  });
}

/** Both pilots: tasks (the work on the board) and agents (who works and how much). */
export function usePilots() {
  return useQuery({ queryKey: keys.pilots, queryFn: () => api.get<Record<PilotKind, PilotSettings>>('/orbi/pilots'), refetchInterval: 30_000 });
}

export function useUpdatePilot(kind: PilotKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Omit<PilotSettings, 'conversationId' | 'lastEventAt'>>) => api.put<PilotSettings>(`/orbi/pilots/${kind}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.pilots }),
  });
}

/** Discards an Órbi proposal from the Órbi page (applying is done in its conversation, where it is explained). */
export function useDecideSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'apply' | 'discard' }) => api.post(`/assistant/proposals/${id}/${decision}`),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}
