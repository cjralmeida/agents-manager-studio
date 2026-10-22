import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import type { Project } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import { toContainerPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { type RemoteInfo, parseRemote, remoteHostname } from '../agents/remote.js';
import { refResolver } from '../boards/dependencies.js';
import { boardContext } from '../boards/service.js';
import type { BoardItem, StatusRole } from '../boards/types.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { addWorkingMs, dayStart, localDay } from './calendar.js';
import { type ProjectHistory, type ProjectMetrics, combineMetrics, projectHistory, shortRef } from './metrics.js';
import { type RoadmapDelivery, deliveryOfTask, isPlanningTask, parseRoadmap } from './parse.js';
import { type ResolvedSystem, workspaceSystems } from './systems.js';

/**
 * The Roadmap tab, one roadmap per system (systems.ts): the roadmap.md in the system's docs home (read from the remote's
 * base branch, or from the local folder when there is no remote) joined with the board tasks of all its projects that
 * carry "Entrega: N", the pace of each project (metrics.ts) and the forecast of each open delivery on the workspace's
 * working calendar. The projects move side by side (e.g. the API by agents, the front by a person), each at its own
 * pace: a delivery ends when its slowest project does.
 */

const CACHE_MS = 60_000;
const HOUR = 3_600_000;
const cache = new Map<string, { at: number; text: string | null; error: string | null; source: 'remote' | 'local' }>();

/** Drops a project's cached roadmap texts (one was just written). */
export const forgetRoadmapText = (projectId: string) => {
  for (const key of cache.keys()) if (key.startsWith(`${projectId}:`)) cache.delete(key);
};

export type DeliveryStatus = 'done' | 'inProgress' | 'planned' | 'notPlanned';
export type DayStatus = 'done' | 'late' | 'today' | 'upcoming';
/** Forecast (or actual) end against the planned deadline. */
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
  projectName: string | null;
}

type TaskOfDelivery = RoadmapTask & { ref: string; delivery: number; planning: boolean; projectId: string };
type DayTask = { ref: string; title: string | null; url: string | null; done: boolean };
type Lane = { projectId: string; projectName: string; metrics: ProjectMetrics | null };

/** The roadmap of every system of the workspace (systems without one come with roadmap null). */
export async function workspaceRoadmaps(workspaceId: string, refresh = false, onlySystem?: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const systems = (await workspaceSystems(workspaceId)).filter((system) => !onlySystem || system.id === onlySystem);
  const board = await boardContext(workspaceId).catch(() => null);
  const roleOf = new Map(Object.entries(board?.statusMap ?? {}).map(([role, columnId]) => [columnId, role as StatusRole]));
  const areaField = board?.snapshot.fields.find((field) => field.name.toLowerCase() === 'área' || field.name.toLowerCase() === 'area');
  const items = board?.snapshot.items ?? [];
  const resolve = refResolver(items);
  const projectNames = new Map(systems.flatMap((system) => system.projects.map((project) => [project.id, project.name] as const)));

  const toTask = (item: BoardItem): RoadmapTask => {
    const projectId = board?.projectOf(item) ?? null;
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      number: item.number,
      area: areaField?.options.find((option) => option.id === item.fields[areaField.id])?.name ?? null,
      role: (item.columnId && roleOf.get(item.columnId)) || null,
      column: board?.snapshot.columns.find((entry) => entry.id === item.columnId)?.name ?? null,
      isClosed: item.isClosed,
      projectName: (projectId && projectNames.get(projectId)) || null,
    };
  };
  const areaOf = (ref: string) => {
    const item = resolve(ref) ?? resolve(shortRef(ref));
    return item ? toTask(item).area : null;
  };

  return Promise.all(
    systems.map(async (system) => {
      const file = await roadmapText(workspace.name, system.docsProject, system.roadmapFile, refresh);
      const deliveries = file.text ? parseRoadmap(file.text) : [];
      const memberIds = new Set(system.projects.map((project) => project.id));
      const tasks: TaskOfDelivery[] = items.flatMap((item) => {
        const projectId = board!.projectOf(item);
        if (!projectId || !memberIds.has(projectId)) return [];
        const delivery = deliveryOfTask(item.body);
        if (delivery === null) return [];
        return [{ ...toTask(item), ref: `${item.repository}#${item.number}`, delivery, planning: isPlanningTask(item.title), projectId }];
      });
      // The pace of each project, for systems with a roadmap (or the one asked for): it reads the provider's closed issues.
      const histories = new Map<string, ProjectHistory>();
      if (file.text !== null || onlySystem) {
        await Promise.all(
          system.projects.map(async (project) => {
            const history = await projectHistory(project, areaOf, refresh).catch(() => null);
            if (history) histories.set(project.id, history);
          }),
        );
      }
      const lanes: Lane[] = system.projects.map((project) => ({ projectId: project.id, projectName: project.name, metrics: histories.get(project.id)?.metrics ?? null }));
      const history = joinHistories(system.name, system.projects.flatMap((project) => histories.get(project.id) ?? []));
      const main = system.projects[0]!;
      const mainRepo = (main.gitRemoteUrl && parseRemote(main.gitRemoteUrl)?.path.split('/').pop()) || main.name;
      const dayTask = (ref: string): DayTask => {
        const full = ref.startsWith('#') ? `${mainRepo}${ref}` : ref;
        const item = resolve(full);
        return { ref: full, title: item?.title ?? null, url: item?.url ?? null, done: item ? isFinished(toTask(item)) : history?.closedAt.has(shortRef(full)) === true };
      };
      const views = deliveries.map((delivery) => deliveryView(delivery, tasks, lanes, history, dayTask));
      if (history) forecast(views, history, lanes);
      const open = views.filter((view) => view.status !== 'done');
      return {
        systemId: system.id,
        systemName: system.name,
        /** A project that is a system by itself (not configured in the workspace's systems). */
        implicit: system.implicit,
        projects: lanes,
        docsProjectId: system.docsProject.id,
        docsProjectName: system.docsProject.name,
        file: system.roadmapFile,
        source: file.source,
        error: file.error,
        roadmap: file.text === null ? null : views,
        /** Tasks marked with a delivery the roadmap does not list (e.g. a typo in "Entrega: N"). */
        orphanTasks: tasks.filter((task) => !deliveries.some((delivery) => delivery.number === task.delivery)).map(stripTask),
        metrics: history?.metrics ?? null,
        /** When the last open delivery is forecast to end; null when the pace is unknown or everything is done. */
        forecastEnd: open.length > 0 ? (open.at(-1)!.forecast.end ?? null) : null,
        remainingCost: open.length > 0 && open.every((view) => view.forecast.cost !== null) ? round(open.reduce((sum, view) => sum + view.forecast.cost!, 0)) : null,
      };
    }),
  );
}

/** One history for the whole system: the combined metrics, and the closings and effort of every project. */
function joinHistories(name: string, list: ProjectHistory[]): ProjectHistory | null {
  const metrics = combineMetrics(name, list.map((history) => history.metrics));
  if (!metrics) return null;
  return {
    metrics,
    closedAt: new Map(list.flatMap((history) => [...history.closedAt])),
    effort: new Map(list.flatMap((history) => [...history.effort])),
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

function deliveryView(delivery: RoadmapDelivery, tasks: TaskOfDelivery[], lanes: Lane[], history: ProjectHistory | null, dayTask: (ref: string) => DayTask) {
  const own = tasks.filter((task) => task.delivery === delivery.number);
  const work = own.filter((task) => !task.planning);
  const finished = work.filter(isFinished);
  const status = deliveryStatus(work);
  const today = localDay(history?.metrics.calendar.timeZone ?? 'America/Sao_Paulo', Date.now());
  const effort = work.flatMap((task) => history?.effort.get(shortRef(task.ref)) ?? []);
  const closedAt = finished.flatMap((task) => history?.closedAt.get(shortRef(task.ref)) ?? []);
  return {
    ...delivery,
    days: delivery.days.map((day) => {
      const dayTasks = day.refs.map(dayTask);
      const done = dayTasks.length > 0 && dayTasks.every((task) => task.done);
      const dayStatus: DayStatus = done ? 'done' : day.date < today ? 'late' : day.date === today ? 'today' : 'upcoming';
      return { ...day, tasks: dayTasks, status: dayStatus };
    }),
    status,
    progress: { done: finished.length, total: work.length },
    /** How far each project of the system is in this delivery, and when it is forecast to finish its part. */
    lanes: lanes
      .map((lane) => {
        const mine = work.filter((task) => task.projectId === lane.projectId);
        return { projectId: lane.projectId, projectName: lane.projectName, done: mine.filter(isFinished).length, total: mine.length, end: null as string | null };
      })
      .filter((lane) => lane.total > 0),
    tasks: work.map(stripTask),
    planningTask: own.find((task) => task.planning) ? stripTask(own.find((task) => task.planning)!) : null,
    /** What the delivery's tasks already cost and took, and when its last task closed. */
    actual: {
      cost: round(effort.reduce((sum, entry) => sum + entry.cost, 0)),
      agentHours: Math.round((effort.reduce((sum, entry) => sum + entry.ms, 0) / HOUR) * 10) / 10,
      finishedAt: status === 'done' && closedAt.length > 0 ? new Date(Math.max(...closedAt)).toISOString() : null,
    },
    forecast: {
      remainingTasks: Math.max(0, (work.length > 0 ? work.length : (delivery.estimatedTasks ?? 0)) - finished.length),
      end: null as string | null,
      cost: null as number | null,
      schedule: null as Schedule | null,
    },
  };
}

/**
 * Walks the open deliveries in order on the working calendar. Each project of the system advances at its own measured
 * pace, starting its part of a delivery when it finished its part of the previous one (the first, now), and never before
 * the delivery's planned start; the delivery
 * ends with its slowest project. A delivery not broken into tasks yet (only "Tarefas previstas") goes at the system's
 * combined pace once every project is done with the previous ones. Cost: the remaining tasks at each project's cost
 * per task.
 */
function forecast(views: ReturnType<typeof deliveryView>[], history: ProjectHistory, lanes: Lane[]) {
  const { metrics } = history;
  const workingDay = metrics.hoursPerWorkingDay * HOUR;
  const cursors = new Map(lanes.map((lane) => [lane.projectId, Date.now()]));
  for (const view of views) {
    if (view.status === 'done') {
      view.forecast.end = view.actual.finishedAt;
      if (view.deadline && view.actual.finishedAt) view.forecast.schedule = scheduleOf(view.actual.finishedAt, view.deadline, metrics.calendar.timeZone);
      continue;
    }
    const notBefore = view.start ? dayStart(metrics.calendar.timeZone, view.start) : 0;
    if (view.progress.total === 0) {
      const remaining = view.forecast.remainingTasks;
      if (metrics.tasksPerDay && remaining > 0) {
        const end = addWorkingMs(metrics.calendar, Math.max(notBefore, ...cursors.values()), (remaining / metrics.tasksPerDay) * workingDay);
        for (const id of cursors.keys()) cursors.set(id, end);
        view.forecast.end = new Date(end).toISOString();
      }
      if (metrics.costPerTask !== null) view.forecast.cost = round(remaining * metrics.costPerTask);
    } else {
      let end: number | null = 0;
      let cost: number | null = 0;
      for (const lane of view.lanes) {
        const remaining = lane.total - lane.done;
        if (remaining === 0) continue;
        const pace = lanes.find((entry) => entry.projectId === lane.projectId)?.metrics;
        const perDay = pace?.tasksPerDay ?? metrics.tasksPerDay;
        if (perDay && end !== null) {
          const laneEnd = addWorkingMs(metrics.calendar, Math.max(notBefore, cursors.get(lane.projectId) ?? Date.now()), (remaining / perDay) * workingDay);
          cursors.set(lane.projectId, laneEnd);
          lane.end = new Date(laneEnd).toISOString();
          end = Math.max(end, laneEnd);
        } else {
          end = null;
        }
        const perTask = pace?.costPerTask ?? metrics.costPerTask;
        cost = perTask === null || cost === null ? null : cost + remaining * perTask;
      }
      view.forecast.end = end ? new Date(end).toISOString() : null;
      view.forecast.cost = cost === null ? null : round(cost);
    }
    if (view.deadline && view.forecast.end) view.forecast.schedule = scheduleOf(view.forecast.end, view.deadline, metrics.calendar.timeZone);
  }
}

function scheduleOf(end: string, deadline: string, timeZone: string): Schedule {
  const day = localDay(timeZone, Date.parse(end));
  if (day < deadline) return 'ahead';
  return day === deadline ? 'onTime' : 'late';
}

const isFinished = (task: RoadmapTask) => task.isClosed || task.role === 'done';

export function deliveryStatus(tasks: RoadmapTask[]): DeliveryStatus {
  if (tasks.length === 0) return 'notPlanned';
  if (tasks.every(isFinished)) return 'done';
  if (tasks.some((task) => isFinished(task) || (task.role !== null && task.role !== 'todo' && task.role !== 'blocked'))) return 'inProgress';
  return 'planned';
}

function stripTask({ id, title, url, number, area, role, column, isClosed, projectName }: RoadmapTask): RoadmapTask {
  return { id, title, url, number, area, role, column, isClosed, projectName };
}

/**
 * A system's roadmap text, for the planner to rewrite it keeping what is there. While the system has none, also the
 * docs/roadmap.md each of its projects had before (roadmaps used to be per project), to be merged into it.
 */
export async function systemRoadmapTexts(workspaceId: string, system: ResolvedSystem) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
  const current = await roadmapText(workspace.name, system.docsProject, system.roadmapFile, true);
  if (current.text !== null || system.implicit) return { content: current.text, legacy: [] };
  const legacy = await Promise.all(
    system.projects.map(async (project) => ({ project: project.name, file: LEGACY_FILE, content: (await roadmapText(workspace.name, project, LEGACY_FILE, true)).text })),
  );
  return { content: null, legacy: legacy.filter((entry) => entry.content !== null) };
}

const LEGACY_FILE = 'docs/roadmap.md';

/**
 * A roadmap file's text, or null when there is none. The remote comes first; when it cannot be read (e.g. no git
 * account for its host), the local folder is used, and the remote error is reported only if that has nothing either.
 */
async function roadmapText(workspaceName: string, project: Project, file: string, refresh: boolean) {
  const key = `${project.id}:${file}`;
  const cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  let entry: { at: number; text: string | null; error: string | null; source: 'remote' | 'local' };
  try {
    entry = remote
      ? { at: Date.now(), text: await remoteFile(project, remote, file), error: null, source: 'remote' }
      : { at: Date.now(), text: await localFile(workspaceName, project.name, file), error: null, source: 'local' };
  } catch (error) {
    const local = await localFile(workspaceName, project.name, file);
    entry = { at: Date.now(), text: local, error: local === null ? (error instanceof Error ? error.message : String(error)) : null, source: 'local' };
  }
  cache.set(key, entry);
  return entry;
}

async function localFile(workspaceName: string, projectName: string, file: string) {
  return readFile(path.posix.join(toContainerPath(workspaceName, projectName), file), 'utf8').catch(() => null);
}

/**
 * A file of a project's repository (the base branch, or `branch`), or null when it is not there. Workflows use it to
 * hand a change package written by one step to the next step's agent, which may not have a copy of that repository.
 */
export async function projectFileText(projectId: string, file: string, branch?: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { workspace: { select: { name: true } } } });
  if (!project) return null;
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  const text = remote ? await remoteFile(project, remote, file, branch).catch(() => null) : null;
  return text ?? (branch ? null : localFile(project.workspace.name, project.name, file));
}

async function remoteFile(project: Project, remote: RemoteInfo, file: string, branch?: string) {
  const account = await findWorkspaceGitAccount(project.workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  const base = branch ?? project.baseBranch;
  const ref = base ? `?ref=${encodeURIComponent(base)}` : '';
  let url: string;
  let headers: Record<string, string>;
  if (account.provider === 'GITHUB') {
    const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`;
    url = `${apiBase}/repos/${remote.path}/contents/${file}${ref}`;
    headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'agents-manager-studio' };
  } else {
    const id = encodeURIComponent(remote.path);
    url = `https://${remote.host}/api/v4/projects/${id}/repository/files/${encodeURIComponent(file)}/raw${ref || '?ref=HEAD'}`;
    headers = { 'PRIVATE-TOKEN': token };
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) throw new Error(`Não foi possível conectar a ${remote.host}.`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`O ${account.provider === 'GITHUB' ? 'GitHub' : 'GitLab'} respondeu ${response.status} ao ler ${file}.`);
  return response.text();
}
