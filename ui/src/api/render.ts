import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type DeployEnvironment = 'HOMOLOGACAO' | 'PRODUCAO';

export const environmentLabels: Record<DeployEnvironment, string> = { HOMOLOGACAO: 'Homologação', PRODUCAO: 'Produção' };

export interface RenderServiceLink {
  id: string;
  projectId: string;
  environment: DeployEnvironment;
  serviceId: string;
  serviceName: string;
  branch: string | null;
  url: string | null;
  dashboardUrl: string | null;
}

export interface RenderSettings {
  /** Render account the workspace picked in its settings. */
  connection: { accountId: string; label: string; ownerName: string; apiKeyHint: string } | null;
  services: RenderServiceLink[];
}

export interface RenderServiceInfo {
  id: string;
  name: string;
  type: string;
  repo: string | null;
  branch: string | null;
  url: string | null;
}

export interface Deployment {
  id: string;
  workspaceId: string;
  projectId: string | null;
  environment: DeployEnvironment;
  serviceName: string;
  status: string;
  statusLabel: string;
  isFinished: boolean;
  isSuccess: boolean;
  commitId: string | null;
  prUrl: string | null;
  agentId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const keys = {
  settings: (workspaceId: string) => ['render', workspaceId, 'settings'] as const,
  available: (workspaceId: string) => ['render', workspaceId, 'available'] as const,
  deployments: (workspaceId: string) => ['render', workspaceId, 'deployments'] as const,
};

export function useRenderSettings(workspaceId: string) {
  return useQuery({ queryKey: keys.settings(workspaceId), queryFn: () => api.get<RenderSettings>(`/workspaces/${workspaceId}/render`) });
}

export function useAvailableRenderServices(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.available(workspaceId),
    queryFn: () => api.get<RenderServiceInfo[]>(`/workspaces/${workspaceId}/render/available-services`),
    enabled,
    staleTime: 60_000,
  });
}

function useSetSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return (settings: RenderSettings) => {
    queryClient.setQueryData(keys.settings(workspaceId), settings);
    void queryClient.invalidateQueries({ queryKey: keys.available(workspaceId) });
  };
}

export function useSetRenderService(workspaceId: string) {
  const setSettings = useSetSettings(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; environment: DeployEnvironment; serviceId: string | null }) =>
      api.put<RenderSettings>(`/workspaces/${workspaceId}/render/services`, input),
    onSuccess: (settings) => {
      setSettings(settings);
      // Render replaces the AWS deploy of the project in that environment (cleared on the server).
      void queryClient.invalidateQueries({ queryKey: ['aws', 'settings', workspaceId] });
    },
  });
}

export function useDeployments(workspaceId: string) {
  return useQuery({
    queryKey: keys.deployments(workspaceId),
    queryFn: () => api.get<Deployment[]>(`/workspaces/${workspaceId}/deployments`),
    refetchInterval: (query) => (query.state.data?.some((deployment) => !deployment.isFinished) ? 5_000 : 30_000),
  });
}

export function useStartDeploy(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; environment: DeployEnvironment }) =>
      api.post<Deployment>(`/workspaces/${workspaceId}/deployments`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.deployments(workspaceId) }),
  });
}

export interface RenderConnectionSummary {
  workspaceId: string;
  workspaceName: string;
  accountLabel: string;
  ownerName: string;
  services: number;
}

/** Workspaces that picked a Render account. */
export function useRenderConnections() {
  return useQuery({ queryKey: ['render', 'connections'] as const, queryFn: () => api.get<RenderConnectionSummary[]>('/render/connections') });
}

// ---------------------------------------------------------------- accounts

export interface RenderAccount {
  id: string;
  label: string;
  ownerName: string;
  apiKeyHint: string;
  workspaceCount: number;
}

const accountKeys = ['render-accounts'] as const;

function useInvalidateAccounts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: accountKeys });
    void queryClient.invalidateQueries({ queryKey: ['render'] });
  };
}

export function useRenderAccounts() {
  return useQuery({ queryKey: accountKeys, queryFn: () => api.get<RenderAccount[]>('/render-accounts') });
}

export function useCreateRenderAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (input: { label: string; apiKey: string }) => api.post<RenderAccount>('/render-accounts', input),
    onSuccess: invalidate,
  });
}

export function useUpdateRenderAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string; apiKey?: string }) =>
      api.patch<RenderAccount>(`/render-accounts/${id}`, input),
    onSuccess: invalidate,
  });
}

/** Checks the stored key on Render again. */
export function useVerifyRenderAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; ownerName: string }>(`/render-accounts/${id}/verify`),
    onSuccess: invalidate,
  });
}

export function useDeleteRenderAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/render-accounts/${id}`),
    onSuccess: invalidate,
  });
}
