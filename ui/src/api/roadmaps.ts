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
  /** The project of the system the task belongs to. */
  projectName: string | null;
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
  /** Progress of each project of the system in this delivery, and when it is forecast to finish its part. */
  lanes: { projectId: string; projectName: string; done: number; total: number; end: string | null }[];
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
  projectId: string;
  projectName: string;
  window: { from: string; to: string };
  calendar: WorkCalendar;
  hoursPerWorkingDay: number;
  productiveHours: number;
  pauses: { auto: { from: string; to: string }[]; manual: { from: string; to: string; reason: string }[]; pausedHours: number };
  tasksDone: number;
  /** Closed issues left out of the pace as a bulk close (a cleanup, not delivered work). */
  bulkClosed: number;
  tasksPerDay: number | null;
  costPerTask: number | null;
  agentHoursPerTask: number | null;
  totalCost: number;
  byArea: { area: string; tasks: number; costPerTask: number; agentHoursPerTask: number }[];
  daily: { day: string; done: number; cost: number }[];
  error: string | null;
}

/** One system's roadmap: a product made of one or more projects, documented in its docs home. */
export interface SystemRoadmap {
  systemId: string;
  systemName: string;
  /** A project that is a system by itself (not configured in the workspace's systems). */
  implicit: boolean;
  projects: { projectId: string; projectName: string; metrics: ProjectMetrics | null }[];
  docsProjectId: string;
  docsProjectName: string;
  /** The roadmap file inside the docs home (e.g. docs/roadmap.md). */
  file: string;
  source: 'remote' | 'local';
  error: string | null;
  /** Null when the system has no roadmap file. */
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
    queryFn: () => api.get<SystemRoadmap[]>(`/workspaces/${workspaceId}/roadmaps`),
    refetchInterval: 60_000,
  });
}

export function useRefreshRoadmaps(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<SystemRoadmap[]>(`/workspaces/${workspaceId}/roadmaps?refresh=true`),
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

export interface SystemConfig {
  name: string;
  /** The first is the main project ("#N" in the roadmap means a task of it). */
  projectIds: string[];
  docsProjectId: string;
  /** Folder of the system's documentation inside the docs project (its roadmap.md goes there). */
  docsPath: string;
}

export function useSystems(workspaceId: string) {
  return useQuery({
    queryKey: ['systems', workspaceId],
    queryFn: () => api.get<{ systems: SystemConfig[] }>(`/workspaces/${workspaceId}/systems`),
  });
}

export function useSaveSystems(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (systems: SystemConfig[]) => api.put<{ systems: SystemConfig[] }>(`/workspaces/${workspaceId}/systems`, { systems }),
    onSuccess: (data) => {
      queryClient.setQueryData(['systems', workspaceId], data);
      void queryClient.invalidateQueries({ queryKey: ['roadmaps', workspaceId] });
    },
  });
}
