import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface StudioSettings {
  githubBoardTemplateUrl: string | null;
  /** Central folder (from .env): each folder in it is a workspace. */
  projectsRoot: { hostPath: string; excluded: string[] };
}

const key = ['studio-settings'] as const;

export function useStudioSettings() {
  return useQuery({ queryKey: key, queryFn: () => api.get<StudioSettings>('/studio-settings') });
}

export function useUpdateStudioSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Pick<StudioSettings, 'githubBoardTemplateUrl'>) => api.put<StudioSettings>('/studio-settings', input),
    onSuccess: (settings) => queryClient.setQueryData(key, settings),
  });
}
