import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { UsageTotals } from './usage';

export type AgentStatus =
  | 'PREPARING'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'READY_FOR_REVIEW'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type AgentModel = 'sonnet' | 'opus' | 'haiku';

/** Outcome reported by a result agent, plus the tasks it created on the board. */
export interface AgentResult {
  status?: 'success' | 'failure';
  summary?: string;
  details?: string;
  createdTasks?: { id: string; title: string; ref: string | null; url: string | null }[];
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface Agent {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  projectId: string;
  projectName: string | null;
  title: string;
  model: AgentModel;
  status: AgentStatus;
  baseBranch: string;
  branch: string;
  workdirHostPath: string;
  isContainerRunning: boolean;
  pendingQuestion: AgentQuestion[] | null;
  prUrl: string | null;
  /** Board item the agent is solving. */
  taskItemId: string | null;
  taskRef: string | null;
  taskUrl: string | null;
  /** Sentinel that launched the agent. */
  sentinelId: string | null;
  sentinelName: string | null;
  /** Workspace agent (profile) this execution runs. */
  profileId: string | null;
  profileName: string | null;
  output: 'PULL_REQUEST' | 'RESULT';
  autoConclude: boolean;
  hasRepository: boolean;
  result: AgentResult | null;
  /** Tokens and estimated cost (API list prices) used by the agent. */
  usage: UsageTotals;
  errorMessage: string | null;
  lastActivityAt: string;
  createdAt: string;
  finishedAt: string | null;
}

export type AgentEvent =
  | { id: number; createdAt: string; type: 'user_message'; data: { text: string } }
  | { id: number; createdAt: string; type: 'assistant_text'; data: { text: string } }
  | { id: number; createdAt: string; type: 'tool_use'; data: { name: string; summary: string } }
  | { id: number; createdAt: string; type: 'question'; data: { questions: AgentQuestion[] } }
  | { id: number; createdAt: string; type: 'answer'; data: { answers: Record<string, string> } }
  | { id: number; createdAt: string; type: 'turn_end'; data: { isError: boolean; text: string; durationMs?: number } }
  | { id: number; createdAt: string; type: 'status'; data: { message: string } }
  | { id: number; createdAt: string; type: 'error'; data: { message: string } }
  | { id: number; createdAt: string; type: 'completed'; data: { prUrl: string } };

export interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface AgentDiff {
  files: DiffFile[];
  patch: string;
  truncated: boolean;
}

export interface LaunchAgentInput {
  /** Null for agents without a repository. */
  projectId?: string | null;
  profileId?: string;
  prompt: string;
  title?: string;
  model?: AgentModel;
  baseBranch?: string;
  taskItemId?: string;
  /** Launch even though Docker usage is above the configured limits. */
  confirmHighUsage?: boolean;
}

/** Statuses where the agent may still change on its own, so the UI keeps polling. */
export const LIVE_STATUSES: AgentStatus[] = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'FINALIZING'];

const agentKeys = {
  all: ['agents'] as const,
  list: (workspaceId?: string) => [...agentKeys.all, 'list', workspaceId ?? 'all'] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
  events: (id: string) => [...agentKeys.all, 'events', id] as const,
  diff: (id: string) => [...agentKeys.all, 'diff', id] as const,
};

export function useAgents(workspaceId?: string) {
  return useQuery({
    queryKey: agentKeys.list(workspaceId),
    queryFn: () => api.get<Agent[]>(workspaceId ? `/agents?workspaceId=${workspaceId}` : '/agents'),
    refetchInterval: 3_000,
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: agentKeys.detail(id),
    queryFn: () => api.get<Agent>(`/agents/${id}`),
    refetchInterval: (query) => (query.state.data && !LIVE_STATUSES.includes(query.state.data.status) ? 10_000 : 2_000),
  });
}

export function useAgentEvents(id: string, isLive: boolean) {
  return useQuery({
    queryKey: agentKeys.events(id),
    queryFn: () => api.get<AgentEvent[]>(`/agents/${id}/events`),
    refetchInterval: isLive ? 2_000 : 10_000,
  });
}

export function useAgentDiff(id: string, enabled: boolean) {
  return useQuery({
    queryKey: agentKeys.diff(id),
    queryFn: () => api.get<AgentDiff>(`/agents/${id}/diff`),
    enabled,
  });
}

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function useLaunchAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (input: LaunchAgentInput) => api.post<Agent>('/agents', input),
    onSuccess: invalidate,
  });
}

export function useSendAgentMessage(id: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (text: string) => api.post<Agent>(`/agents/${id}/messages`, { text }),
    onSuccess: invalidate,
  });
}

export function useAnswerAgent(id: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (answers: Record<string, string>) => api.post<Agent>(`/agents/${id}/answer`, { answers }),
    onSuccess: invalidate,
  });
}

export function useAgentAction(id: string, action: 'finalize' | 'cancel') {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: () => api.post<Agent>(`/agents/${id}/${action}`),
    onSuccess: invalidate,
  });
}

export function useDeleteAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/agents/${id}`),
    onSuccess: invalidate,
  });
}
