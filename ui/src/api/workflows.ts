import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentStatus } from './agents';
import { api } from './client';
import type { DeployEnvironment } from './render';

export type WorkflowTrigger =
  | { type: 'manual' }
  | {
      type: 'board_task';
      columnId: string | null;
      fieldFilters: Record<string, string[]>;
      repositories: string[];
      onlyUnassigned: boolean;
      moveWhenDone: 'done' | 'homologation';
    }
  | { type: 'feature_in_homologation'; repositories: string[] }
  | { type: 'task_awaiting_decision'; repositories: string[] };

export interface AgentStep {
  id: string;
  name: string;
  kind: 'agent';
  profileId: string;
  forEachTask: boolean;
  maxParallel: number;
  continueFromPrevious: boolean;
  fromTaskPullRequest: boolean;
  /** Model for this step only; null uses the agent's. */
  model: 'sonnet' | 'opus' | 'haiku' | null;
  instructions: string;
  onFailure: { retryStepId: string; maxAttempts: number } | null;
}

export interface DeployStep {
  id: string;
  name: string;
  kind: 'deploy';
  environment: DeployEnvironment;
}

export type WorkflowStep = AgentStep | DeployStep;

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  isEnabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  maxConcurrentRuns: number;
  lastCheckedAt: string | null;
  statusMessage: string | null;
  runningRuns: number;
  totalRuns: number;
}

export type WorkflowInput = Pick<Workflow, 'name' | 'description' | 'isEnabled' | 'trigger' | 'steps' | 'maxConcurrentRuns'>;

export type StepRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RETRIED' | 'CANCELLED';

export interface StepRun {
  id: string;
  stepId: string;
  stepIndex: number;
  /** "main", or the board task id after a step that runs per created task. */
  lane: string;
  attempt: number;
  status: StepRunStatus;
  agentId: string | null;
  agentStatus: AgentStatus | null;
  deploymentId: string | null;
  output: {
    summary?: string;
    prUrl?: string | null;
    createdTasks?: { id: string; title: string; ref: string | null; url: string | null }[];
    deployStatus?: string;
    serviceName?: string;
  } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  workspaceId: string;
  /** Only on the list of active runs of every workspace. */
  workspaceName?: string;
  title: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  definition: { id: string; name: string; kind: 'agent' | 'deploy' }[];
  /** Board tasks the run works on. */
  taskItemIds: string[];
  steps: StepRun[];
}

const keys = {
  workflows: (workspaceId: string) => ['workflows', workspaceId] as const,
  runs: (workspaceId: string) => ['workflow-runs', workspaceId] as const,
};

export function useWorkflows(workspaceId: string) {
  return useQuery({
    queryKey: keys.workflows(workspaceId),
    queryFn: () => api.get<Workflow[]>(`/workspaces/${workspaceId}/workflows`),
    refetchInterval: 15_000,
  });
}

export function useWorkflowRuns(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: keys.runs(workspaceId),
    queryFn: () => api.get<WorkflowRun[]>(`/workspaces/${workspaceId}/workflow-runs`),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'RUNNING') ? 5_000 : 20_000),
  });
}

function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.workflows(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: keys.runs(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  };
}

export function useCreateWorkflow(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: WorkflowInput) => api.post<Workflow>(`/workspaces/${workspaceId}/workflows`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateWorkflow(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<WorkflowInput> & { id: string }) => api.patch<Workflow>(`/workflows/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteWorkflow(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/workflows/${id}`), onSuccess: invalidate });
}

export function useStartWorkflow(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: ({ id, message }: { id: string; message?: string }) =>
      api.post<{ runId: string | null }>(`/workflows/${id}/start`, message ? { message } : {}),
    onSuccess: invalidate,
  });
}

export function useCancelRun(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.post<WorkflowRun>(`/workflow-runs/${id}/cancel`), onSuccess: invalidate });
}

/** Board tasks running workflows are working on, in every workspace the user sees (to light their cards up). */
export function useActiveWorkflowTasks() {
  return useQuery({
    queryKey: ['workflow-runs', 'active-tasks'] as const,
    queryFn: () => api.get<{ workspaceId: string; taskItemId: string; runId: string }[]>('/workflow-runs/active-tasks'),
    refetchInterval: 10_000,
  });
}

/** "Is a running workflow working on this task?" for a workspace board, or for the board of all workspaces. */
export function useInActiveWorkflow() {
  const active = useActiveWorkflowTasks();
  const keys = new Set((active.data ?? []).map((entry) => `${entry.workspaceId}|${entry.taskItemId}`));
  return (workspaceId: string, taskItemId: string) => keys.has(`${workspaceId}|${taskItemId}`);
}

/** Running workflow runs of every workspace the user sees (general dashboard). */
export function useActiveRuns(enabled = true) {
  return useQuery({
    queryKey: ['workflow-runs', 'active'] as const,
    queryFn: () => api.get<WorkflowRun[]>('/workflow-runs/active'),
    refetchInterval: 10_000,
    enabled,
  });
}
