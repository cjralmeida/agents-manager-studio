import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface WorkspaceSettings {
  agentAccountId: string | null;
  renderAccountId: string | null;
  gitAccountIds: string[];
  enabledSkillIds: string[];
}

const settingsKey = (workspaceId: string) => ['workspace-settings', workspaceId] as const;

export function useWorkspaceSettings(workspaceId: string) {
  return useQuery({
    queryKey: settingsKey(workspaceId),
    queryFn: () => api.get<WorkspaceSettings>(`/workspaces/${workspaceId}/settings`),
  });
}

export function useUpdateWorkspaceSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: WorkspaceSettings) =>
      api.put<WorkspaceSettings>(`/workspaces/${workspaceId}/settings`, settings),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKey(workspaceId), saved);
      // Account usage counts changed.
      void queryClient.invalidateQueries({ queryKey: ['git-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['render-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['render'] });
    },
  });
}

export function useCopyWorkspaceSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetWorkspaceIds: string[]) =>
      api.post<{ copiedTo: number }>(`/workspaces/${workspaceId}/settings/copy`, { targetWorkspaceIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['git-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-accounts'] });
    },
  });
}
