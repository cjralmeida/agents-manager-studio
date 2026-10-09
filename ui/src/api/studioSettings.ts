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

export interface HostHelper {
  /** The Windows helper (studio.ps1) answered in the last seconds. */
  online: boolean;
  studioDir: string | null;
  installCommand: string;
  lastResult: { id: string; status: 'applying' | 'done' | 'error'; at: string; error: string | null } | null;
}

export function useHostHelper() {
  return useQuery({ queryKey: ['host-helper'] as const, queryFn: () => api.get<HostHelper>('/host-helper'), refetchInterval: 5_000 });
}

export interface ProjectsRootRequest {
  /** Null when the helper is not running: the command must be run by hand. */
  requestId: string | null;
  hostPath: string;
  command: string;
}

export function useRequestProjectsRoot() {
  return useMutation({
    mutationFn: (input: { hostPath: string; excluded: string[] }) => api.post<ProjectsRootRequest>('/studio-settings/projects-root', input),
  });
}
