import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from './boards';
import { api } from './client';

export type DeliveryStatus = 'done' | 'inProgress' | 'planned' | 'notPlanned';
export type DayStatus = 'done' | 'late' | 'today' | 'upcoming';
export type Schedule = 'ahead' | 'onTime' | 'late';

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

export interface RoadmapDay {
  date: string;
  goal: string;
  refs: string[];
  tasks: { ref: string; title: string | null; url: string | null; done: boolean }[];
  status: DayStatus;
}

export interface RoadmapDelivery {
  number: number;
  name: string;
  objective: string;
  scope: string;
  outOfScope: string;
  doneCriteria: string;
  notes: string;
  start: string | null;
  deadline: string | null;
  estimatedTasks: number | null;
  days: RoadmapDay[];
  status: DeliveryStatus;
  progress: { done: number; total: number };
  tasks: RoadmapTask[];
  /** The "Planejar a Entrega N" milestone, when the board has one. */
  planningTask: RoadmapTask | null;
  actual: { cost: number; agentHours: number; finishedAt: string | null };
  forecast: { remainingTasks: number; end: string | null; cost: number | null; schedule: Schedule | null };
}

export interface WorkCalendar {
  timeZone: string;
  days: number[];
  start: string;
  end: string;
}

export interface ProjectMetrics {
  window: { from: string; to: string };
  calendar: WorkCalendar;
  hoursPerWorkingDay: number;
  productiveHours: number;
  pauses: { auto: { from: string; to: string }[]; manual: { from: string; to: string; reason: string }[]; pausedHours: number };
  tasksDone: number;
  tasksPerDay: number | null;
  costPerTask: number | null;
  agentHoursPerTask: number | null;
  totalCost: number;
  byArea: { area: string; tasks: number; costPerTask: number; agentHoursPerTask: number }[];
  daily: { day: string; done: number; cost: number }[];
  error: string | null;
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
  metrics: ProjectMetrics | null;
  forecastEnd: string | null;
  remainingCost: number | null;
}

export interface RoadmapSettings {
  calendar: WorkCalendar;
  autoPauseHours: number;
  pauses: { from: string; to: string; reason: string }[];
}

export function useRoadmaps(workspaceId: string) {
  return useQuery({
    queryKey: ['roadmaps', workspaceId],
    queryFn: () => api.get<ProjectRoadmap[]>(`/workspaces/${workspaceId}/roadmaps`),
    refetchInterval: 60_000,
  });
}

export function useRefreshRoadmaps(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<ProjectRoadmap[]>(`/workspaces/${workspaceId}/roadmaps?refresh=true`),
    onSuccess: (data) => queryClient.setQueryData(['roadmaps', workspaceId], data),
  });
}

export function useRoadmapSettings(workspaceId: string) {
  return useQuery({
    queryKey: ['roadmap-settings', workspaceId],
    queryFn: () => api.get<RoadmapSettings>(`/workspaces/${workspaceId}/roadmap-settings`),
  });
}

export function useSaveRoadmapSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: RoadmapSettings) => api.put<RoadmapSettings>(`/workspaces/${workspaceId}/roadmap-settings`, settings),
    onSuccess: (data) => {
      queryClient.setQueryData(['roadmap-settings', workspaceId], data);
      void queryClient.invalidateQueries({ queryKey: ['roadmaps', workspaceId] });
    },
  });
}
