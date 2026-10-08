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
    };

export interface AgentStep {
  id: string;
  name: string;
  kind: 'agent';
  profileId: string;
  forEachTask: boolean;
  maxParallel: number;
  continueFromPrevious: boolean;
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
  title: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  definition: { id: string; name: string; kind: 'agent' | 'deploy' }[];
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

export function useWorkflowRuns(workspaceId: string) {
  return useQuery({
    queryKey: keys.runs(workspaceId),
    queryFn: () => api.get<WorkflowRun[]>(`/workspaces/${workspaceId}/workflow-runs`),
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
