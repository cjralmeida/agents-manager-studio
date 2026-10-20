import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type QualityStatus = 'aberta' | 'transversal' | 'resolvida' | 'nao_defeito';
export type LearningPhase = 'especificacao' | 'codificacao' | 'assets' | 'testes' | 'publicacao';

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
  /** Stage whose agents learn from it. */
  phase: LearningPhase;
  /** What those agents do to avoid it (null: they get the last "expected × obtained"). */
  lesson: string | null;
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

/** Each stage, with the agents that get its lessons in their prompt (same as the server). */
export const learningPhases: { id: LearningPhase; label: string; learners: string }[] = [
  { id: 'especificacao', label: 'Especificação', learners: 'spec-architect, task-forge, backlog-steward, game-designer, game-planner' },
  { id: 'codificacao', label: 'Codificação', learners: 'backend-builder, game-builder; os revisores e testadores conferem' },
  { id: 'assets', label: 'Arte e áudio', learners: 'pixel-forge, audio-forge' },
  { id: 'testes', label: 'Testes', learners: 'code-guardian, hom-api-ranger, hom-ranger, hom-screen-ranger, play-tester' },
  { id: 'publicacao', label: 'Publicação', learners: 'hom-launcher' },
];

const key = (workspaceId: string) => ['quality', workspaceId];

/** What the workspace learned: the defects the reviewers logged, with stage and lesson. */
export function useQuality(workspaceId: string) {
  return useQuery({ queryKey: key(workspaceId), queryFn: () => api.get<QualityCategory[]>(`/workspaces/${workspaceId}/quality`), refetchInterval: 60_000 });
}

export function useUpdateQualityCategory(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; status?: QualityStatus; transversalRef?: string | null; phase?: LearningPhase; lesson?: string | null }) =>
      api.patch(`/workspaces/${workspaceId}/quality/categories/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}
