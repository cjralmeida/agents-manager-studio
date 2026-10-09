import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent } from './agents';
import { api } from './client';

export interface Conversation {
  id: string;
  title: string;
  status: Agent['status'];
  lastActivityAt: string;
  createdAt: string;
}

export type ProposalStatus = 'PENDING' | 'APPLIED' | 'DISCARDED' | 'FAILED';

export interface Proposal {
  id: string;
  agentId: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ProposalStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
}

export const proposalKindLabels: Record<string, string> = {
  create_agent: 'Criar agente',
  update_agent: 'Alterar agente',
  delete_agent: 'Excluir agente',
  create_workflow: 'Criar workflow',
  update_workflow: 'Alterar workflow',
  delete_workflow: 'Excluir workflow',
  start_workflow: 'Iniciar workflow',
  cancel_run: 'Cancelar execução',
  create_task: 'Criar tarefa',
  update_workspace_settings: 'Configurar o workspace',
  create_board: 'Criar quadro',
  link_board: 'Vincular quadro',
  create_local_board: 'Tarefas do Studio no quadro',
  set_render_service: 'Serviço do Render',
};

const keys = {
  conversations: (workspaceId: string) => ['orbi', workspaceId, 'conversations'] as const,
  proposals: (agentId: string) => ['orbi', 'proposals', agentId] as const,
};

export function useConversations(workspaceId: string | null) {
  return useQuery({
    queryKey: keys.conversations(workspaceId ?? ''),
    queryFn: () => api.get<Conversation[]>(`/workspaces/${workspaceId}/assistant/conversations`),
    enabled: Boolean(workspaceId),
  });
}

export function useStartConversation(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: string; context?: string }) =>
      api.post<Agent>(`/workspaces/${workspaceId}/assistant/conversations`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.conversations(workspaceId ?? '') }),
  });
}

export function useSendToConversation(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: string; context?: string }) => api.post<Agent>(`/assistant/conversations/${agentId}/messages`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useProposals(agentId: string) {
  return useQuery({
    queryKey: keys.proposals(agentId),
    queryFn: () => api.get<Proposal[]>(`/assistant/conversations/${agentId}/proposals`),
    refetchInterval: 5_000,
  });
}

/** Applying changes agents, workflows or the board, so everything is refreshed. */
export function useDecideProposal(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'apply' | 'discard' }) => api.post<Proposal>(`/assistant/proposals/${id}/${decision}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.proposals(agentId) });
      void queryClient.invalidateQueries();
    },
  });
}
