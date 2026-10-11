import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface PreviewBuild {
  id: string;
  status: 'RUNNING' | 'PASSED' | 'FAILED';
  branch: string;
  commit: string;
  commitMessage: string;
  /** How the project runs. */
  kind: 'static' | 'dockerfile' | 'compose';
  /** Site folder (static), container port (dockerfile) or "service:port" (compose). */
  target: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Only on the latest build, when it failed. */
  log?: string;
}

export interface PreviewState {
  /** Projects need a GitHub/GitLab remote: the stable version comes from it. */
  supported: boolean;
  url: string;
  wantsUp: boolean;
  running: boolean;
  checking: boolean;
  error: string | null;
  /** Build being served now. */
  served: PreviewBuild | null;
  /** Latest build that passed. */
  stable: PreviewBuild | null;
  /** Latest build of all (may have failed). */
  latest: PreviewBuild | null;
}

const key = (projectId: string) => ['preview', projectId];

export function usePreview(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => api.get<PreviewState>(`/projects/${projectId}/preview`),
    enabled,
    // Faster while something changes (a check running, or starting up).
    refetchInterval: (query) => {
      const state = query.state.data;
      if (!state) return false;
      return state.checking || state.latest?.status === 'RUNNING' || (state.wantsUp && !state.running) ? 4_000 : 30_000;
    },
  });
}

function usePreviewAction(projectId: string, action: 'start' | 'stop' | 'check') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PreviewState>(`/projects/${projectId}/preview/${action}`),
    onSuccess: (state) => queryClient.setQueryData(key(projectId), state),
  });
}

export const useStartPreview = (projectId: string) => usePreviewAction(projectId, 'start');
export const useStopPreview = (projectId: string) => usePreviewAction(projectId, 'stop');
export const useCheckPreview = (projectId: string) => usePreviewAction(projectId, 'check');
