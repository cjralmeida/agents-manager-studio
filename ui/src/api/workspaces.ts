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
    // Workspaces also change outside this screen (another tab, Órbi, the scan), so the menu keeps up.
    refetchInterval: 30_000,
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

/** Creates a folder in the central folder and registers it as a workspace. */
export function useCreateWorkspace() {
  const invalidate = useInvalidateWorkspaces();
  return useMutation({
    mutationFn: (name: string) => api.post<WorkspaceDetail>('/workspaces', { name }),
    onSuccess: invalidate,
  });
}

export interface AccountRepository {
  provider: 'GITHUB' | 'GITLAB';
  host: string;
  account: string;
  fullName: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  description: string | null;
  updatedAt: string | null;
}

export interface CloneJob {
  id: string;
  url: string;
  folder: string;
  branch: string | null;
  status: 'cloning' | 'done' | 'failed';
  error: string | null;
  projectId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Repositories the workspace git accounts can reach (GitLab searches by project name). */
export function useAccountRepositories(workspaceId: string, search: string, enabled: boolean) {
  return useQuery({
    queryKey: [...workspaceKeys.all, workspaceId, 'repositories', search] as const,
    queryFn: () =>
      api.get<{ repositories: AccountRepository[]; warnings: string[] }>(
        `/workspaces/${workspaceId}/repositories?search=${encodeURIComponent(search)}`,
      ),
    enabled,
    staleTime: 60_000,
  });
}

/** Clones of the workspace; polled while one is running, and the workspace is refreshed when one ends. */
export function useCloneJobs(workspaceId: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [...workspaceKeys.all, workspaceId, 'clones'] as const,
    queryFn: async () => {
      const jobs = await api.get<CloneJob[]>(`/workspaces/${workspaceId}/clones`);
      if (jobs.some((job) => job.status === 'done')) void queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(workspaceId) });
      return jobs;
    },
    refetchInterval: (query) => (query.state.data?.some((job) => job.status === 'cloning') ? 2_000 : false),
  });
}

export function useStartClone(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { url: string; folder?: string; branch?: string }) => api.post<CloneJob>(`/workspaces/${workspaceId}/clones`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...workspaceKeys.all, workspaceId, 'clones'] }),
  });
}

export interface RepositoryOwnerAccount {
  accountId: string;
  label: string;
  provider: 'GITHUB' | 'GITLAB';
  host: string;
  owners: { path: string; kind: 'user' | 'org' | 'group'; id: number | null }[];
}

/** Where the workspace git accounts can create a repository (own user, organizations, groups). */
export function useRepositoryOwners(workspaceId: string) {
  return useQuery({
    queryKey: [...workspaceKeys.all, workspaceId, 'repository-owners'] as const,
    queryFn: () => api.get<{ accounts: RepositoryOwnerAccount[]; warnings: string[] }>(`/workspaces/${workspaceId}/repository-owners`),
    staleTime: 5 * 60_000,
  });
}

export interface NewProjectInput {
  name: string;
  description?: string;
  remote: { accountId: string; owner: string; visibility: 'private' | 'public' } | null;
}

export function useCreateProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewProjectInput) =>
      api.post<{ projectId: string | null; folder: string; remoteUrl: string | null; remotePath: string | null; remoteVisibility: 'private' | 'public' | null }>(`/workspaces/${workspaceId}/projects`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(workspaceId) }),
  });
}
