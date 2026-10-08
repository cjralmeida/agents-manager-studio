import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type BoardProvider = 'GITHUB' | 'GITLAB';
export type StatusRole = 'todo' | 'inProgress' | 'review' | 'done' | 'blocked';
export type StatusMap = Partial<Record<StatusRole, string>>;

export interface BoardLink {
  provider: BoardProvider;
  host: string;
  ownerPath: string;
  title: string;
  url: string;
  statusMap: StatusMap;
}

export interface BoardOption {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

export interface BoardField {
  id: string;
  name: string;
  options: BoardOption[];
}

export interface BoardItem {
  id: string;
  title: string;
  body: string;
  url: string | null;
  number: number | null;
  repository: string | null;
  isDraft: boolean;
  isClosed: boolean;
  columnId: string | null;
  fields: Record<string, string>;
  assignees: string[];
  pullRequests: { url: string; number: number; state: string }[];
  updatedAt: string;
  /** Workspace project whose remote is the item repository. */
  projectId: string | null;
}

export interface BoardRepository {
  projectId: string;
  projectName: string;
  path: string;
}

export interface Board {
  link: BoardLink;
  title: string;
  url: string;
  readme: string | null;
  columns: BoardOption[];
  fields: BoardField[];
  items: BoardItem[];
  supportsDrafts: boolean;
  taskBodyTemplate: string;
  repositories: BoardRepository[];
}

export interface BoardCandidate {
  provider: BoardProvider;
  host: string;
  externalId: string;
  ownerPath: string;
  title: string;
  url: string;
  matchesTemplate: boolean;
}

export interface CreateOption {
  provider: BoardProvider;
  host: string;
  owner: string;
}

export interface BoardDetection {
  candidates: BoardCandidate[];
  createOptions: CreateOption[];
  warnings: string[];
  defaultTitle: string;
}

export interface NewTaskInput {
  title: string;
  body: string;
  repository: string | null;
  columnId: string | null;
  fields: Record<string, string>;
}

export const statusRoleLabels: Record<StatusRole, string> = {
  todo: 'A fazer',
  inProgress: 'Agente trabalhando',
  review: 'PR/MR aberto',
  done: 'Concluído',
  blocked: 'Bloqueado para agentes',
};

export const boardProviderLabels: Record<BoardProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab' };

const boardKeys = {
  all: (workspaceId: string) => ['board', workspaceId] as const,
  link: (workspaceId: string) => ['board', workspaceId, 'link'] as const,
  contents: (workspaceId: string) => ['board', workspaceId, 'contents'] as const,
  detect: (workspaceId: string) => ['board', workspaceId, 'detect'] as const,
};

const base = (workspaceId: string) => `/workspaces/${workspaceId}/board`;

export function useBoardLink(workspaceId: string) {
  return useQuery({
    queryKey: boardKeys.link(workspaceId),
    queryFn: () => api.get<BoardLink | null>(`/workspaces/${workspaceId}/board-link`),
  });
}

/** Board contents; the server caches the provider for ~20s, so polling stays cheap. */
export function useBoard(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: boardKeys.contents(workspaceId),
    queryFn: () => api.get<Board>(base(workspaceId)),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useRefreshBoard(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<Board>(`${base(workspaceId)}?refresh=true`),
    onSuccess: (board) => queryClient.setQueryData(boardKeys.contents(workspaceId), board),
  });
}

export function useDetectBoards(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: boardKeys.detect(workspaceId),
    queryFn: () => api.get<BoardDetection>(`${base(workspaceId)}/detect`),
    enabled,
    staleTime: 60_000,
  });
}

function useInvalidateBoard(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: boardKeys.all(workspaceId) });
}

export function useLinkBoard(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  return useMutation({
    mutationFn: (url: string) => api.post<BoardLink>(`${base(workspaceId)}/link`, { url }),
    onSuccess: invalidate,
  });
}

export function useCreateBoard(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  return useMutation({
    mutationFn: (input: CreateOption & { title: string }) =>
      api.post<{ link: BoardLink; warnings: string[] }>(`${base(workspaceId)}/create`, input),
    onSuccess: invalidate,
  });
}

export function useUnlinkBoard(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`${base(workspaceId)}/link`),
    onSuccess: () => queryClient.resetQueries({ queryKey: boardKeys.all(workspaceId) }),
  });
}

export function useUpdateStatusMap(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  return useMutation({
    mutationFn: (map: StatusMap) => api.put<BoardLink>(`${base(workspaceId)}/status-map`, map),
    onSuccess: invalidate,
  });
}

/** Applies a change to the cached board right away; the server confirms or the board is reloaded. */
function useOptimisticItemUpdate<T>(
  workspaceId: string,
  request: (input: T) => Promise<unknown>,
  apply: (item: BoardItem, input: T) => BoardItem,
  itemIdOf: (input: T) => string,
) {
  const queryClient = useQueryClient();
  const key = boardKeys.contents(workspaceId);
  return useMutation({
    mutationFn: request,
    onMutate: async (input: T) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Board>(key);
      if (previous) {
        queryClient.setQueryData<Board>(key, {
          ...previous,
          items: previous.items.map((item) => (item.id === itemIdOf(input) ? apply(item, input) : item)),
        });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useMoveTask(workspaceId: string) {
  return useOptimisticItemUpdate<{ itemId: string; columnId: string }>(
    workspaceId,
    ({ itemId, columnId }) => api.post<void>(`${base(workspaceId)}/items/${encodeURIComponent(itemId)}/move`, { columnId }),
    (item, { columnId }) => ({ ...item, columnId }),
    (input) => input.itemId,
  );
}

export function useSetTaskField(workspaceId: string) {
  return useOptimisticItemUpdate<{ itemId: string; fieldId: string; optionId: string | null }>(
    workspaceId,
    ({ itemId, fieldId, optionId }) =>
      api.post<void>(`${base(workspaceId)}/items/${encodeURIComponent(itemId)}/field`, { fieldId, optionId }),
    (item, { fieldId, optionId }) => {
      const fields = { ...item.fields };
      if (optionId) fields[fieldId] = optionId;
      else delete fields[fieldId];
      return { ...item, fields };
    },
    (input) => input.itemId,
  );
}

export function useCreateTask(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewTaskInput) => api.post<{ id: string }>(`${base(workspaceId)}/items`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardKeys.contents(workspaceId) }),
  });
}
