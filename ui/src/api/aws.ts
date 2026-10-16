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

export interface AwsServiceLink {
  id: string;
  projectId: string;
  environment: DeployEnvironment;
  kind: 'ec2' | 'amplify';
  name: string;
  url: string | null;
  branch: string | null;
  config: Record<string, unknown>;
}

export interface AwsSettings {
  connection: { accountId: string; label: string; region: string; awsAccountNumber: string } | null;
  services: AwsServiceLink[];
}

export interface AwsTargets {
  instances: { instanceId: string; name: string | null; online: boolean; platform: string | null; ip: string | null }[] | { error: string };
  amplifyApps: { appId: string; name: string; domain: string; repository: string | null }[] | { error: string };
}

export type AwsServiceInput =
  | { projectId: string; environment: DeployEnvironment; kind: 'ec2'; url: string; branch: string; instanceId: string; port: number; healthPath?: string; dockerfile?: string }
  | { projectId: string; environment: DeployEnvironment; kind: 'amplify'; url?: string; branch: string; appId: string }
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
  return useQuery({ queryKey: keys.settings(workspaceId), queryFn: () => api.get<AwsSettings>(`/workspaces/${workspaceId}/aws`) });
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
    onSuccess: (data) => queryClient.setQueryData(keys.settings(workspaceId), data),
  });
}
