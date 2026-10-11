import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** Workflows that together reach one goal (e.g. "Criação de jogo"), shown as one canvas. */
export interface WorkflowProcess {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  workflowIds: string[];
  createdAt: string;
}

export type ProcessInput = Pick<WorkflowProcess, 'name' | 'description' | 'workflowIds'>;

const key = (workspaceId: string) => ['processes', workspaceId] as const;

export function useProcesses(workspaceId: string) {
  return useQuery({ queryKey: key(workspaceId), queryFn: () => api.get<WorkflowProcess[]>(`/workspaces/${workspaceId}/processes`) });
}

/** A workflow moves between processes, so the workflows are refreshed too. */
function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: key(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ['workflows', workspaceId] });
  };
}

export function useCreateProcess(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: ProcessInput) => api.post<WorkflowProcess>(`/workspaces/${workspaceId}/processes`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateProcess(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<ProcessInput> & { id: string }) => api.patch<WorkflowProcess>(`/processes/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteProcess(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({ mutationFn: (id: string) => api.delete<void>(`/processes/${id}`), onSuccess: invalidate });
}
