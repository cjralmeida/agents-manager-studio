import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type AccountGitProvider = 'GITHUB' | 'GITLAB';

export interface GitAccount {
  id: string;
  provider: AccountGitProvider;
  label: string;
  host: string;
  username: string;
  tokenHint: string;
  workspaceCount: number;
}

export interface AgentAccount {
  id: string;
  provider: 'CLAUDE';
  label: string;
  tokenHint: string;
  workspaceCount: number;
}

export interface CreateGitAccountInput {
  provider: AccountGitProvider;
  label: string;
  host?: string;
  token: string;
}

export interface AccountUpdate {
  label?: string;
  token?: string;
}

const gitKeys = ['git-accounts'] as const;
const agentKeys = ['agent-accounts'] as const;

/** Account changes also change counts shown in workspace settings. */
function useInvalidate(key: readonly string[]) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

export function useGitAccounts() {
  return useQuery({ queryKey: gitKeys, queryFn: () => api.get<GitAccount[]>('/git-accounts') });
}

export function useCreateGitAccount() {
  const invalidate = useInvalidate(gitKeys);
  return useMutation({
    mutationFn: (input: CreateGitAccountInput) => api.post<GitAccount>('/git-accounts', input),
    onSuccess: invalidate,
  });
}

export function useUpdateGitAccount() {
  const invalidate = useInvalidate(gitKeys);
  return useMutation({
    mutationFn: ({ id, ...input }: AccountUpdate & { id: string }) =>
      api.patch<GitAccount>(`/git-accounts/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useVerifyGitAccount() {
  const invalidate = useInvalidate(gitKeys);
  return useMutation({
    mutationFn: (id: string) => api.post<{ username: string }>(`/git-accounts/${id}/verify`),
    onSuccess: invalidate,
  });
}

export function useDeleteGitAccount() {
  const invalidate = useInvalidate(gitKeys);
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/git-accounts/${id}`),
    onSuccess: invalidate,
  });
}

export function useAgentAccounts() {
  return useQuery({ queryKey: agentKeys, queryFn: () => api.get<AgentAccount[]>('/agent-accounts') });
}

export function useCreateAgentAccount() {
  const invalidate = useInvalidate(agentKeys);
  return useMutation({
    mutationFn: (input: Required<AccountUpdate>) => api.post<AgentAccount>('/agent-accounts', input),
    onSuccess: invalidate,
  });
}

export function useUpdateAgentAccount() {
  const invalidate = useInvalidate(agentKeys);
  return useMutation({
    mutationFn: ({ id, ...input }: AccountUpdate & { id: string }) =>
      api.patch<AgentAccount>(`/agent-accounts/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAgentAccount() {
  const invalidate = useInvalidate(agentKeys);
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/agent-accounts/${id}`),
    onSuccess: invalidate,
  });
}
