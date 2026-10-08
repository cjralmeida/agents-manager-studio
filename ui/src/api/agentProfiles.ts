import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentModel } from './agents';
import { api } from './client';

export type AgentOutput = 'PULL_REQUEST' | 'RESULT';
export type ProfileTool = 'board';

/** A fixed agent of the workspace; each run of it is an Agent (execution). */
export interface AgentProfile {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  model: AgentModel;
  /** Empty: works without a repository. */
  projectIds: string[];
  output: AgentOutput;
  tools: ProfileTool[];
  autoConclude: boolean;
  workingAgents: number;
  totalAgents: number;
  createdAt: string;
}

export type AgentProfileInput = Pick<
  AgentProfile,
  'name' | 'description' | 'instructions' | 'model' | 'projectIds' | 'output' | 'tools' | 'autoConclude'
>;

export const outputLabels: Record<AgentOutput, string> = {
  PULL_REQUEST: 'Código (commit + PR/MR)',
  RESULT: 'Resultado (relatório, tarefas criadas)',
};

export const toolLabels: Record<ProfileTool, string> = {
  board: 'Quadro de tarefas (consultar, criar e mover tarefas)',
};

const key = (workspaceId: string) => ['agent-profiles', workspaceId] as const;

export function useAgentProfiles(workspaceId: string) {
  return useQuery({
    queryKey: key(workspaceId),
    queryFn: () => api.get<AgentProfile[]>(`/workspaces/${workspaceId}/agent-profiles`),
  });
}

function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: key(workspaceId) });
}

export function useCreateAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: AgentProfileInput) => api.post<AgentProfile>(`/workspaces/${workspaceId}/agent-profiles`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<AgentProfileInput> & { id: string }) =>
      api.patch<AgentProfile>(`/agent-profiles/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/agent-profiles/${id}`), onSuccess: invalidate });
}
