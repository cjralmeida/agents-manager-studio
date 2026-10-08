import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type GitProvider = 'GITHUB' | 'GITLAB' | 'OTHER';

export interface WorkspaceSummary {
  id: string;
  name: string;
  hostPath: string;
  isIgnored: boolean;
  isMissing: boolean;
  projectCount: number;
  gitProjectCount: number;
}

export interface Project {
  id: string;
  name: string;
  hostPath: string;
  isGitRepo: boolean;
  gitRemoteUrl: string | null;
  gitProvider: GitProvider | null;
  isMissing: boolean;
}

export interface WorkspaceDetail extends Omit<WorkspaceSummary, 'projectCount' | 'gitProjectCount'> {
  projects: Project[];
}

interface ScanCounts {
  total: number;
  added: number;
  missing: number;
}

export interface ScanSummary {
  workspaces: ScanCounts;
  projects: ScanCounts;
}

const workspaceKeys = {
  all: ['workspaces'] as const,
  list: (includeIgnored: boolean) => [...workspaceKeys.all, 'list', includeIgnored] as const,
  detail: (id: string) => [...workspaceKeys.all, 'detail', id] as const,
};

export function useWorkspaces(includeIgnored = false) {
  return useQuery({
    queryKey: workspaceKeys.list(includeIgnored),
    queryFn: () => api.get<WorkspaceSummary[]>(`/workspaces?includeIgnored=${includeIgnored}`),
  });
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: workspaceKeys.detail(id),
    queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${id}`),
  });
}

/** Mutations change lists and details alike, so every workspace query is refreshed. */
function useInvalidateWorkspaces() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
}

export function useScanWorkspaces() {
  const invalidate = useInvalidateWorkspaces();
  return useMutation({
    mutationFn: () => api.post<ScanSummary>('/workspaces/scan'),
    onSuccess: invalidate,
  });
}

export function useSetWorkspaceIgnored() {
  const invalidate = useInvalidateWorkspaces();
  return useMutation({
    mutationFn: ({ id, isIgnored }: { id: string; isIgnored: boolean }) =>
      api.patch<WorkspaceDetail>(`/workspaces/${id}`, { isIgnored }),
    onSuccess: invalidate,
  });
}

export function useDeleteWorkspace() {
  const invalidate = useInvalidateWorkspaces();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/workspaces/${id}`),
    onSuccess: invalidate,
  });
}
