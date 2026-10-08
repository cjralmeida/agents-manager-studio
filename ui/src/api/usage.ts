import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface PlanWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageSummary {
  accounts: {
    id: string;
    label: string;
    plan: { status: string | null; windows: PlanWindow[] } | null;
    planUpdatedAt: string | null;
  }[];
  periods: { today: UsageTotals; week: UsageTotals; month: UsageTotals };
  byWorkspace: (UsageTotals & { workspaceId: string; name: string })[];
  byModel: (UsageTotals & { model: string })[];
  topAgents: (UsageTotals & { agentId: string; title: string; workspaceName: string | null })[];
  daily: { day: string; costUsd: number; tokens: number }[];
}

const key = ['usage', 'summary'] as const;

/** Without a workspace: every workspace; with one, only its agents (plan limits are the account's). */
export function useUsageSummary(workspaceId?: string) {
  return useQuery({
    queryKey: [...key, workspaceId ?? 'all'],
    queryFn: () => api.get<UsageSummary>(workspaceId ? `/usage/summary?workspaceId=${workspaceId}` : '/usage/summary'),
    refetchInterval: 30_000,
  });
}

/** A tiny Claude request (Haiku) that also brings the current plan limits. */
export function useRefreshPlanUsage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.post<{ ok: true }>(`/agent-accounts/${accountId}/verify`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }), // every scope (all and per workspace)
  });
}

export const totalTokens = (usage: UsageTotals) =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return '< US$ 0,01';
  return usd.format(value);
}

export function formatTokens(value: number) {
  return compact.format(value);
}
