import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** STUDIO: a board only in the Studio, without GitHub/GitLab. */
export type BoardProvider = 'GITHUB' | 'GITLAB' | 'STUDIO';
export type StatusRole = 'todo' | 'inProgress' | 'review' | 'homologation' | 'done' | 'blocked';
export type StatusMap = Partial<Record<StatusRole, string>>;

export interface BoardLink {
  provider: BoardProvider;
  host: string;
  ownerPath: string;
  title: string;
  url: string;
  statusMap: StatusMap;
  /** The server reads the board from the provider this often. */
  refreshIntervalSec: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  /** "synced" follows the Studio model; "drift" was changed on the provider; "pending" was never converted. */
  modelStatus: 'synced' | 'drift' | 'pending';
  modelSyncError: string | null;
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

/** What the kanban/table views need: a workspace board, or the model for all workspaces. */
export type BoardLayout = Pick<Board, 'columns' | 'fields'> & { link: Pick<BoardLink, 'statusMap'> };

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
  homologation: 'Em homologação',
  done: 'Concluído',
  blocked: 'Bloqueado para agentes',
};

export const boardProviderLabels: Record<BoardProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab', STUDIO: 'Studio' };

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

/** Board contents as last read by the server (it refreshes them on its own), so polling stays cheap. */
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

/** A board only in the Studio, following the board model. */
export function useCreateLocalBoard(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  return useMutation({ mutationFn: () => api.post<BoardLink>(`${base(workspaceId)}/local`), onSuccess: invalidate });
}

export function useUnlinkBoard(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`${base(workspaceId)}/link`),
    onSuccess: () => queryClient.resetQueries({ queryKey: boardKeys.all(workspaceId) }),
  });
}

export function useUpdateBoardSettings(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  return useMutation({
    mutationFn: (input: { refreshIntervalSec: number }) => api.put<BoardLink>(`${base(workspaceId)}/settings`, input),
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

// ---------------------------------------------------------------- structure

/** GitHub's single-select palette, also used for GitLab labels; hex tuned for the dark UI (as on the server). */
export const boardColors = {
  GRAY: '#8b949e',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#a371f7',
} as const;
export type BoardColor = keyof typeof boardColors;

export const boardColorLabels: Record<BoardColor, string> = {
  GRAY: 'Cinza',
  BLUE: 'Azul',
  GREEN: 'Verde',
  YELLOW: 'Amarelo',
  ORANGE: 'Laranja',
  RED: 'Vermelho',
  PINK: 'Rosa',
  PURPLE: 'Roxo',
};

export interface StructureOption {
  /** Provider id; null for a new one. */
  id: string | null;
  name: string;
  color: BoardColor;
  description: string;
}

export interface StructureField {
  id: string | null;
  name: string;
  options: StructureOption[];
}

export interface BoardStructure {
  /** On GitLab, without the fixed "A fazer" and "Concluído". */
  columns: StructureOption[];
  fields: StructureField[];
}

export interface ModelColumn extends StructureOption {
  role: StatusRole | null;
}

/** The Studio board model: every workspace board follows it. New entries (editor) have id null. */
export interface BoardModel {
  columns: ModelColumn[];
  fields: StructureField[];
}

export interface ModelBoardSummary {
  workspaceId: string;
  workspaceName: string;
  provider: BoardProvider;
  title: string;
  url: string;
  modelStatus: BoardLink['modelStatus'];
  modelSyncError: string | null;
}

export interface ModelState {
  model: BoardModel;
  /** Cards per model column, field and option over the boards that follow it. */
  usage: { columns: Record<string, number>; options: Record<string, Record<string, number>>; fields: Record<string, number> };
  boards: ModelBoardSummary[];
}

export interface StructurePlan {
  changes: string[];
  removedColumns: { id: string; name: string; items: number }[];
  lostValues: { field: string; option: string | null; items: number }[];
}

export interface PropagationResult {
  workspaceId: string;
  workspaceName: string;
  status: 'applied' | 'skipped' | 'failed';
  message: string;
}

const modelKey = ['board-model'] as const;

export function useBoardModel() {
  return useQuery({ queryKey: modelKey, queryFn: () => api.get<ModelState>('/board-model'), refetchOnWindowFocus: false });
}

export function usePreviewModel() {
  return useMutation({ mutationFn: (model: BoardModel) => api.post<StructurePlan>('/board-model/preview', { model }) });
}

export function useApplyModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: BoardModel; columnMoves: Record<string, string> }) =>
      api.put<{ model: BoardModel; results: PropagationResult[] }>('/board-model', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: modelKey });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

// ---------------------------------------------------------------- converting a workspace board to the model

/** Provider id -> model id; fields and options may go to null (removed). */
export interface ConversionMapping {
  columns: Record<string, string>;
  fields: Record<string, string | null>;
  options: Record<string, Record<string, string | null>>;
}

export interface ConversionState {
  link: BoardLink;
  provider: BoardProvider;
  model: { columns: (ModelColumn & { id: string; fixed: boolean })[]; fields: StructureField[] };
  /** The board as it is on the provider (GitLab's fixed columns left out). */
  current: BoardStructure;
  suggestion: ConversionMapping;
  columnItems: Record<string, number>;
  optionItems: Record<string, Record<string, number>>;
}

export function useBoardConversion(workspaceId: string) {
  return useQuery({
    queryKey: [...boardKeys.all(workspaceId), 'conversion'] as const,
    queryFn: () => api.get<ConversionState>(`${base(workspaceId)}/conversion`),
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function usePreviewConversion(workspaceId: string) {
  return useMutation({
    mutationFn: (mapping: ConversionMapping) =>
      api.post<{ changes: string[]; lostValues: StructurePlan['lostValues']; movedCards: number }>(`${base(workspaceId)}/conversion/preview`, { mapping }),
  });
}

export function useApplyConversion(workspaceId: string) {
  const invalidate = useInvalidateBoard(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mapping: ConversionMapping) => api.put<{ applied: number; link: BoardLink }>(`${base(workspaceId)}/conversion`, { mapping }),
    onSuccess: () => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: modelKey });
    },
  });
}

// ---------------------------------------------------------------- tasks of every workspace

export interface OverviewItem extends BoardItem {
  /** "<workspaceId>:<item id>", unique over all workspaces. */
  id: string;
  /** The task id on its own board. */
  itemId: string;
  workspaceId: string;
  workspaceName: string;
  /** Other workspaces whose board has this same task (listed once). */
  alsoIn: string[];
}

export interface Overview {
  columns: BoardOption[];
  fields: BoardField[];
  statusMap: StatusMap;
  items: OverviewItem[];
  /** Boards left out (not converted to the model, or unreadable). */
  excluded: { workspaceId: string; workspaceName: string; reason: string }[];
}

const overviewKey = ['board-overview'] as const;

export function useAllTasks() {
  return useQuery({ queryKey: overviewKey, queryFn: () => api.get<Overview>('/boards/tasks'), refetchInterval: 60_000 });
}

export function useMoveOverviewTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { item: OverviewItem; columnId: string }) =>
      api.post<void>('/boards/tasks/move', { workspaceId: input.item.workspaceId, itemId: input.item.itemId, columnId: input.columnId }),
    // The card moves at once; the server answer (or the next read) confirms.
    onMutate: ({ item, columnId }) => {
      queryClient.setQueryData<Overview>(overviewKey, (data) =>
        data && { ...data, items: data.items.map((entry) => (entry.id === item.id ? { ...entry, columnId } : entry)) },
      );
    },
    onSettled: (_data, _error, { item }) => {
      void queryClient.invalidateQueries({ queryKey: overviewKey });
      void queryClient.invalidateQueries({ queryKey: ['board', item.workspaceId] });
    },
  });
}
