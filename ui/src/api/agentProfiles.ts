import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentModel } from './agents';
import { api } from './client';

export type AgentOutput = 'PULL_REQUEST' | 'RESULT';
export type ProfileTool = 'board' | 'render' | 'render_read' | 'clickup_read';

/** A fixed agent of the workspace; each run of it is an Agent (execution). */
export interface AgentProfile {
  id: string;
  workspaceId: string;
  /** Filled when listing agents of every workspace. */
  workspaceName: string | null;
  name: string;
  description: string;
  instructions: string;
  model: AgentModel;
  /** Empty: works without a repository. */
  projectIds: string[];
  /** Projects it only reads (mounted read-only as they are on disk). */
  contextProjectIds: string[];
  output: AgentOutput;
  tools: ProfileTool[];
  autoConclude: boolean;
  /** Merges its own PR/MR as soon as it is opened. */
  autoMerge: boolean;
  workingAgents: number;
  totalAgents: number;
  createdAt: string;
}

export type AgentProfileInput = Pick<
  AgentProfile,
  'name' | 'description' | 'instructions' | 'model' | 'projectIds' | 'contextProjectIds' | 'output' | 'tools' | 'autoConclude' | 'autoMerge'
>;

export const outputLabels: Record<AgentOutput, string> = {
  PULL_REQUEST: 'Código (commit + PR/MR)',
  RESULT: 'Resultado (relatório, tarefas criadas)',
};

export const toolLabels: Record<ProfileTool, string> = {
  board: 'Quadro de tarefas (consultar, criar e mover tarefas)',
  render: 'Render em homologação (variáveis, deploy e logs)',
  render_read: 'Homologação, só leitura (URLs e logs dos projetos)',
  clickup_read: 'ClickUp, só leitura (tarefas da conta do workspace)',
};

const key = (workspaceId: string) => ['agent-profiles', workspaceId] as const;

/** Agents of every workspace (general dashboard). */
export function useAllAgentProfiles(enabled = true) {
  return useQuery({ queryKey: ['agent-profiles', 'all'] as const, queryFn: () => api.get<AgentProfile[]>('/agent-profiles'), enabled });
}

export function useAgentProfiles(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: key(workspaceId),
    queryFn: () => api.get<AgentProfile[]>(`/workspaces/${workspaceId}/agent-profiles`),
    enabled,
  });
}

/** A change shows in the workspace list and in the all-workspaces list. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['agent-profiles'] });
}

export function useCreateAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AgentProfileInput) => api.post<AgentProfile>(`/workspaces/${workspaceId}/agent-profiles`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<AgentProfileInput> & { id: string }) =>
      api.patch<AgentProfile>(`/agent-profiles/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAgentProfile(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/agent-profiles/${id}`), onSuccess: invalidate });
}
