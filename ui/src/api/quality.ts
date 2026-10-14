import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type QualityStatus = 'aberta' | 'transversal' | 'resolvida' | 'nao_defeito';

export interface QualityOccurrence {
  id: string;
  taskRef: string;
  expected: string;
  obtained: string;
  reviewer: string | null;
  agentId: string | null;
  createdAt: string;
}

export interface QualityCategory {
  id: string;
  name: string;
  status: QualityStatus;
  transversalRef: string | null;
  /** Different tasks with this defect. */
  tasks: number;
  updatedAt: string;
  occurrences: QualityOccurrence[];
}

export const qualityStatusLabels: Record<QualityStatus, string> = {
  aberta: 'Aberta',
  transversal: 'Correção na base aberta',
  resolvida: 'Resolvida',
  nao_defeito: 'Não é defeito',
};

const key = (workspaceId: string) => ['quality', workspaceId];

/** Recurring defects of the workspace, logged by the reviewers. */
export function useQuality(workspaceId: string) {
  return useQuery({ queryKey: key(workspaceId), queryFn: () => api.get<QualityCategory[]>(`/workspaces/${workspaceId}/quality`), refetchInterval: 60_000 });
}

export function useUpdateQualityCategory(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; status?: QualityStatus; transversalRef?: string | null }) =>
      api.patch(`/workspaces/${workspaceId}/quality/categories/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}
