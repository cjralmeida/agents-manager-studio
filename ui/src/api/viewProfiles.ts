import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** A named set of workspaces the Studio shows (e.g. "Tech Lead - GlobalRas"). */
export interface ViewProfile {
  id: string;
  name: string;
  workspaceIds: string[];
}

export interface ViewProfiles {
  profiles: ViewProfile[];
  /** null: every workspace ("Visão geral"). */
  activeId: string | null;
  /** Executions waiting for an answer in workspaces the active profile hides. */
  hiddenWaiting: number;
}

export type ViewProfileInput = { id: string | null; name: string; workspaceIds: string[] };

const key = ['view-profiles'] as const;

export function useViewProfiles() {
  return useQuery({ queryKey: key, queryFn: () => api.get<ViewProfiles>('/view-profiles'), refetchInterval: 30_000 });
}

export function useSaveViewProfiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profiles: ViewProfileInput[]) => api.put<ViewProfiles>('/view-profiles', { profiles }),
    // An edited active profile changes what every list shows.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Switching profiles changes every list in the Studio, so everything is reloaded. */
export function useSetActiveViewProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string | null) => api.put<ViewProfiles>('/view-profiles/active', { id }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
