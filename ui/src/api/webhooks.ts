import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface BoardWebhook {
  id: string;
  title: string;
  provider: 'GITHUB' | 'GITLAB';
  ownerPath: string;
  url: string;
  workspace: string;
  /** Null until the Studio tried to set it up (no public address yet). */
  webhook: { ok: boolean; scope: 'organization' | 'group' | 'projects' | null; hookIds: string[]; error: string | null; at: string } | null;
}

export interface Webhooks {
  publicUrl: string | null;
  receivers: { gitlab: string; github: string } | null;
  lastDelivery: { at: string; provider: 'GITHUB' | 'GITLAB'; event: string; owner: string | null; boards: number } | null;
  boards: BoardWebhook[];
}

const key = ['webhooks'] as const;

export function useWebhooks() {
  return useQuery({ queryKey: key, queryFn: () => api.get<Webhooks>('/webhooks'), refetchInterval: 15_000 });
}

export function useSaveWebhookUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicUrl: string | null) => api.put<{ ok: boolean }>('/webhooks', { publicUrl }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useSetupWebhooks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/webhooks/setup', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
