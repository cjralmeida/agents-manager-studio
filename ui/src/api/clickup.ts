import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** ClickUp account (personal API token kept encrypted); agents only read tasks through it. */
export interface ClickupAccount {
  id: string;
  label: string;
  username: string;
  tokenHint: string;
  workspaceCount: number;
}

const key = ['clickup-accounts'] as const;

export function useClickupAccounts() {
  return useQuery({ queryKey: key, queryFn: () => api.get<ClickupAccount[]>('/clickup-accounts') });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

export function useCreateClickupAccount() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: { label: string; token: string }) => api.post<ClickupAccount>('/clickup-accounts', input), onSuccess: invalidate });
}

export function useUpdateClickupAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string; token?: string }) => api.patch<ClickupAccount>(`/clickup-accounts/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useVerifyClickupAccount() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.post<{ ok: true; username: string }>(`/clickup-accounts/${id}/verify`), onSuccess: invalidate });
}

export function useDeleteClickupAccount() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/clickup-accounts/${id}`), onSuccess: invalidate });
}
