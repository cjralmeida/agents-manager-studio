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
  connection: { ownerName: string; apiKeyHint: string } | null;
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

export function useConnectRender(workspaceId: string) {
  const setSettings = useSetSettings(workspaceId);
  return useMutation({
    mutationFn: (apiKey: string) => api.put<RenderSettings>(`/workspaces/${workspaceId}/render`, { apiKey }),
    onSuccess: setSettings,
  });
}

export function useDisconnectRender(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/workspaces/${workspaceId}/render`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['render', workspaceId] }),
  });
}

export function useSetRenderService(workspaceId: string) {
  const setSettings = useSetSettings(workspaceId);
  return useMutation({
    mutationFn: (input: { projectId: string; environment: DeployEnvironment; serviceId: string | null }) =>
      api.put<RenderSettings>(`/workspaces/${workspaceId}/render/services`, input),
    onSuccess: setSettings,
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
  ownerName: string;
  services: number;
}

/** Workspaces with Render connected (the key is set per workspace). */
export function useRenderConnections() {
  return useQuery({ queryKey: ['render', 'connections'] as const, queryFn: () => api.get<RenderConnectionSummary[]>('/render/connections') });
}
