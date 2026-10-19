import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent } from './agents';
import { api } from './client';

/** An image or audio to send to Órbi (content in base64). */
export interface AttachmentUpload {
  name: string;
  type: string;
  data: string;
  transcript?: string;
}

type MessageInput = { message: string; context?: string; attachments?: AttachmentUpload[] };

export interface Conversation {
  id: string;
  title: string;
  status: Agent['status'];
  lastActivityAt: string;
  createdAt: string;
  /** The workspace the conversation is focused on (Órbi can move it with studio_focus). */
  workspaceId: string;
  workspaceName: string;
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
  conversations: ['orbi', 'conversations'] as const,
  proposals: (agentId: string) => ['orbi', 'proposals', agentId] as const,
};

/** The user's Órbi conversations, over all workspaces. */
export function useConversations() {
  return useQuery({
    queryKey: keys.conversations,
    queryFn: () => api.get<Conversation[]>('/assistant/conversations'),
    refetchInterval: 15_000,
  });
}

export function useStartConversation(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MessageInput) => api.post<Agent>(`/workspaces/${workspaceId}/assistant/conversations`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.conversations }),
  });
}

export function useSendToConversation(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MessageInput) => api.post<Agent>(`/assistant/conversations/${agentId}/messages`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
}

/**
 * Deletes an Órbi conversation: its history and its folder, with the images and audios sent to it, go with it (the
 * next message starts a new one).
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/agents/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations });
      void queryClient.invalidateQueries({ queryKey: ['orbi'] });
    },
  });
}

export function useRenameConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patch<{ id: string; title: string }>(`/assistant/conversations/${id}`, { title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.conversations });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
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
