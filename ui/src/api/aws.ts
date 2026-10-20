import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { DeployEnvironment } from './render';

export interface AwsAccount {
  id: string;
  label: string;
  region: string;
  accessKeyId: string;
  secretHint: string;
  awsAccountNumber: string;
  identityArn: string;
  workspaceCount: number;
}

/** What the Studio set up in the account for a service: progress, and the DNS records to create by hand, if any. */
export interface AwsSetupState {
  status: 'running' | 'done' | 'failed';
  step: string;
  error: string | null;
  dns: { name: string; type: string; value: string }[];
  dnsManual: boolean;
  updatedAt: string;
}

export interface AwsServiceLink {
  id: string;
  projectId: string;
  environment: DeployEnvironment;
  kind: 'ec2' | 'amplify';
  name: string;
  url: string | null;
  branch: string | null;
  config: Record<string, unknown> & { setup?: AwsSetupState };
}

export interface AwsSettings {
  connection: { accountId: string; label: string; region: string; awsAccountNumber: string } | null;
  services: AwsServiceLink[];
}

export interface Ec2Instance {
  instanceId: string;
  name: string | null;
  type: string | null;
  state: string | null;
  publicIp: string | null;
  studio: boolean;
}

export interface AwsTargets {
  /** Instances the SSM agent reports (the ones the Studio can run commands on). */
  instances: { instanceId: string; name: string | null; online: boolean; platform: string | null; ip: string | null }[] | { error: string };
  ec2Instances: Ec2Instance[] | { error: string };
  amplifyApps: { appId: string; name: string; domain: string; repository: string | null }[] | { error: string };
  instanceTypes: string[];
}

export type AwsServiceInput =
  | {
      projectId: string;
      environment: DeployEnvironment;
      kind: 'ec2';
      url: string;
      branch: string;
      instanceId?: string;
      newInstanceType?: string;
      port?: number;
      healthPath?: string;
      dockerfile?: string;
    }
  | { projectId: string; environment: DeployEnvironment; kind: 'amplify'; url?: string; branch: string; appId?: string; outputDir?: string }
  | { projectId: string; environment: DeployEnvironment; kind: null };

const keys = {
  accounts: ['aws', 'accounts'] as const,
  settings: (workspaceId: string) => ['aws', 'settings', workspaceId] as const,
  targets: (workspaceId: string) => ['aws', 'targets', workspaceId] as const,
};

export function useAwsAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: () => api.get<AwsAccount[]>('/aws-accounts') });
}

export function useCreateAwsAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; region: string; accessKeyId: string; secretAccessKey: string }) => api.post<AwsAccount>('/aws-accounts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useUpdateAwsAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string; region?: string; accessKeyId?: string; secretAccessKey?: string }) => api.patch<AwsAccount>(`/aws-accounts/${id}`, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useVerifyAwsAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; account: string; arn: string }>(`/aws-accounts/${id}/verify`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useDeleteAwsAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/aws-accounts/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useAwsSettings(workspaceId: string) {
  return useQuery({
    queryKey: keys.settings(workspaceId),
    queryFn: () => api.get<AwsSettings>(`/workspaces/${workspaceId}/aws`),
    // Follows a setup in progress (instance, DNS, domain).
    refetchInterval: (query) => (query.state.data?.services.some((service) => service.config.setup?.status === 'running') ? 5_000 : false),
  });
}

export function useSetWorkspaceAwsAccount(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string | null) => api.put<AwsSettings>(`/workspaces/${workspaceId}/aws/account`, { accountId }),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.settings(workspaceId), data);
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
    },
  });
}

export function useAwsTargets(workspaceId: string, enabled: boolean) {
  return useQuery({ queryKey: keys.targets(workspaceId), queryFn: () => api.get<AwsTargets>(`/workspaces/${workspaceId}/aws/targets`), enabled, staleTime: 60_000 });
}

export function useSetAwsService(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AwsServiceInput) => api.put<AwsSettings>(`/workspaces/${workspaceId}/aws/services`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.settings(workspaceId), data);
      // A project deploys to one place per environment: the server clears its Render service; a new instance or app shows up.
      void queryClient.invalidateQueries({ queryKey: ['render', workspaceId, 'settings'] });
      void queryClient.invalidateQueries({ queryKey: keys.targets(workspaceId) });
    },
  });
}

export function useRetryAwsSetup(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => api.post<AwsSettings>(`/workspaces/${workspaceId}/aws/services/${serviceId}/setup`),
    onSuccess: (data) => queryClient.setQueryData(keys.settings(workspaceId), data),
  });
}
