import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentQuestion } from './agents';
import type { AttachmentUpload } from './assistant';
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

export type RoutineMode = 'auto' | 'assistant';

export interface OrbiRoutine {
  id: string;
  name: string;
  instructions: string;
  /** Empty: every workspace of the user. */
  workspaceIds: string[];
  everyMinutes: number | null;
  /** "HH:MM", São Paulo time. */
  dailyAt: string[];
  events: string[];
  mode: RoutineMode;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export type RoutineInput = Omit<OrbiRoutine, 'id' | 'lastRunAt' | 'createdAt'>;

export interface OrbiConversationInfo {
  conversationId: string | null;
  model: 'sonnet' | 'opus';
}

const keys = {
  pending: ['orbi', 'pending'] as const,
  activity: ['orbi', 'activity'] as const,
  conversation: ['orbi', 'conversation'] as const,
  routines: ['orbi', 'routines'] as const,
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

/** Failures marked as seen leave the list: some runs, or (no runIds) everything up to now. */
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

/** The user's answer to a decision Órbi left: an option, a note, or neither ("let's talk"). It goes to the conversation. */
export function useDecideFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, option, note }: { id: string; option?: string; note?: string }) =>
      api.post<{ conversationId: string }>(`/orbi/flags/${id}/decide`, { ...(option && { option }), ...(note && { note }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.pending });
      void queryClient.invalidateQueries({ queryKey: keys.activity });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

/** The user's one Órbi conversation (null until the first message) and its model. */
export function useOrbiConversation() {
  return useQuery({ queryKey: keys.conversation, queryFn: () => api.get<OrbiConversationInfo>('/orbi/conversation'), refetchInterval: 15_000 });
}

export function useSendToOrbi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: string; context?: string; workspaceId?: string; attachments?: AttachmentUpload[] }) => api.post<Agent>('/orbi/conversation/messages', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversation });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useSetOrbiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: OrbiConversationInfo['model']) => api.put<OrbiConversationInfo>('/orbi/conversation/model', { model }),
    onSuccess: (data) => queryClient.setQueryData(keys.conversation, data),
  });
}

/** The next message starts a fresh conversation; the old one stays in the history. */
export function useRestartOrbi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OrbiConversationInfo>('/orbi/conversation/restart'),
    onSuccess: (data) => queryClient.setQueryData(keys.conversation, data),
  });
}

export function useRoutines() {
  return useQuery({
    queryKey: keys.routines,
    queryFn: () => api.get<{ routines: OrbiRoutine[]; events: Record<string, string> }>('/orbi/routines'),
    refetchInterval: 30_000,
  });
}

export function useSaveRoutine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<RoutineInput> & { id?: string }) =>
      id ? api.patch<OrbiRoutine>(`/orbi/routines/${id}`, input) : api.post<OrbiRoutine>('/orbi/routines', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.routines }),
  });
}

export function useDeleteRoutine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/orbi/routines/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.routines }),
  });
}

export function useRunRoutine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<OrbiRoutine>(`/orbi/routines/${id}/run`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.routines });
      void queryClient.invalidateQueries({ queryKey: keys.conversation });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
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
