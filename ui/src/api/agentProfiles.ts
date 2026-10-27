import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentModel } from './agents';
import { api } from './client';
import type { SizeName } from './resourceSettings';

export type AgentOutput = 'PULL_REQUEST' | 'RESULT';
export type ProfileTool = 'board' | 'hom' | 'hom_read' | 'clickup_read' | 'projects' | 'pixellab' | 'test_env' | 'roadmap';

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
  /** Works on the project the workflow is on (e.g. one an earlier step created). */
  anyProject: boolean;
  output: AgentOutput;
  tools: ProfileTool[];
  autoConclude: boolean;
  /** Merges its own PR/MR as soon as it is opened. */
  autoMerge: boolean;
  /** CPU and memory of its container (sizes in Configurações → Recursos); null: by its role. */
  resourceSize: SizeName | null;
  /** Size on "automatic", by the role (skill) it names. */
  roleSize: SizeName;
  workingAgents: number;
  totalAgents: number;
  createdAt: string;
}

export type AgentProfileInput = Pick<
  AgentProfile,
  'name' | 'description' | 'instructions' | 'model' | 'projectIds' | 'contextProjectIds' | 'anyProject' | 'output' | 'tools' | 'autoConclude' | 'autoMerge' | 'resourceSize'
>;

export const outputLabels: Record<AgentOutput, string> = {
  PULL_REQUEST: 'Código (commit + PR/MR)',
  RESULT: 'Resultado (relatório, tarefas criadas)',
};

export const toolLabels: Record<ProfileTool, string> = {
  board: 'Quadro de tarefas (consultar, criar e mover tarefas)',
  hom: 'Homologação (variáveis, publicação e logs, no Render ou na AWS)',
  hom_read: 'Homologação, só leitura (URLs e logs dos projetos)',
  clickup_read: 'ClickUp, só leitura (tarefas da conta do workspace)',
  pixellab: 'PixelLab (gerar e animar pixel art; gasta créditos da conta do workspace)',
  test_env: 'Ambiente de teste local (subir uma cópia do projeto em Docker quando a homologação não estiver utilizável)',
  projects: 'Projetos (criar repositório novo, com sua confirmação)',
  roadmap: 'Roadmap (ler o ritmo e gravar docs/roadmap.md dos projetos na branch base)',
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
