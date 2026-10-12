import { useQuery } from '@tanstack/react-query';
import type { StatusRole } from './boards';
import { api } from './client';

export type DeliveryStatus = 'done' | 'inProgress' | 'planned' | 'notPlanned';

export interface RoadmapTask {
  id: string;
  title: string;
  url: string | null;
  number: number | null;
  area: string | null;
  role: StatusRole | null;
  column: string | null;
  isClosed: boolean;
}

export interface RoadmapDelivery {
  number: number;
  name: string;
  objective: string;
  scope: string;
  outOfScope: string;
  doneCriteria: string;
  notes: string;
  status: DeliveryStatus;
  progress: { done: number; total: number };
  tasks: RoadmapTask[];
  /** The "Planejar a Entrega N" milestone, when the board has one. */
  planningTask: RoadmapTask | null;
}

export interface ProjectRoadmap {
  projectId: string;
  projectName: string;
  file: string;
  source: 'remote' | 'local';
  error: string | null;
  /** Null when the project has no docs/roadmap.md. */
  roadmap: RoadmapDelivery[] | null;
  orphanTasks: RoadmapTask[];
}

export function useRoadmaps(workspaceId: string) {
  return useQuery({
    queryKey: ['roadmaps', workspaceId],
    queryFn: () => api.get<ProjectRoadmap[]>(`/workspaces/${workspaceId}/roadmaps`),
    refetchInterval: 60_000,
  });
}
