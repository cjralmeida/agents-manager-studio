import { prisma } from '../../db.js';
import type { Project } from '../../generated/prisma/client.js';
import { secrets } from '../../lib/secrets.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { type Interval, type WorkCalendar, idleGaps, localDay, totalMs, union, workingMs, workingWindows } from './calendar.js';
import { calendarOf, manualPauses, roadmapSettings } from './settings.js';

/**
 * What a project's history says about its pace, for planning: tasks finished per working day, and the cost and agent
 * time a task takes (by area). Time is counted on the workspace's working calendar, minus the pauses — the marked ones
 * and every stretch of working time with nothing being worked on — so days the work stood still do not slow the rate.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** History read for the rates. */
const WINDOW_DAYS = 45;
const CACHE_MS = 10 * 60_000;

export interface ClosedTask {
  ref: string;
  title: string;
  closedAt: number;
}

export interface AreaMetrics {
  area: string;
  tasks: number;
  /** Average per task finished (USD, list prices). */
  costPerTask: number;
  agentHoursPerTask: number;
}

export interface ProjectMetrics {
  projectId: string;
  projectName: string;
  window: { from: string; to: string };
  calendar: WorkCalendar;
  /** Working hours of one calendar working day (24 with agents round the clock, 10 for 7h-17h). */
  hoursPerWorkingDay: number;
  /** Productive working hours in the window (working time minus pauses). */
  productiveHours: number;
  pauses: { auto: { from: string; to: string }[]; manual: { from: string; to: string; reason: string }[]; pausedHours: number };
  tasksDone: number;
  /** Closed issues left out of the pace as a bulk close (a cleanup, not delivered work). */
  bulkClosed: number;
  /** Tasks finished per productive working day; null without history. */
  tasksPerDay: number | null;
  costPerTask: number | null;
  agentHoursPerTask: number | null;
  totalCost: number;
  byArea: AreaMetrics[];
  /** Tasks finished and cost per local day, oldest first. */
  daily: { day: string; done: number; cost: number }[];
  error: string | null;
}

/** The metrics plus what the roadmap needs per task: when it closed and what it cost. */
export interface ProjectHistory {
  metrics: ProjectMetrics;
  closedAt: Map<string, number>;
  effort: Map<string, { cost: number; ms: number }>;
}

const cache = new Map<string, { at: number; value: ProjectHistory }>();

/** Drops the cached history (the calendar or the pauses changed). */
export const forgetHistory = () => cache.clear();

/** Short ref "repo#12" of "group/sub/repo#12". */
export const shortRef = (ref: string) => {
  const hash = ref.lastIndexOf('#');
  return `${ref.slice(0, hash).split('/').pop()}#${ref.slice(hash + 1)}`.toLowerCase();
};

export async function projectHistory(project: Project, areaOf: (ref: string) => string | null, refresh = false): Promise<ProjectHistory> {
  const cached = cache.get(project.id);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const settings = await roadmapSettings(project.workspaceId);
  const calendar = calendarOf(settings);
  const to = Date.now();
  const from = to - WINDOW_DAYS * DAY;

  const [agents, runs] = await Promise.all([
    prisma.agent.findMany({
      where: { workspaceId: project.workspaceId, createdAt: { gte: new Date(from) } },
      select: { projectId: true, taskRef: true, costUsd: true, createdAt: true, finishedAt: true, lastActivityAt: true },
    }),
    prisma.workflowRun.findMany({ where: { workspaceId: project.workspaceId, startedAt: { gte: new Date(from) } }, select: { startedAt: true, finishedAt: true } }),
  ]);
  const activity: Interval[] = [
    ...agents.map((agent) => ({ from: agent.createdAt.getTime(), to: (agent.finishedAt ?? agent.lastActivityAt).getTime() })),
    ...runs.map((run) => ({ from: run.startedAt.getTime(), to: (run.finishedAt ?? new Date(to)).getTime() })),
  ];

  let closed: ClosedTask[] = [];
  let error: string | null = null;
  try {
    closed = await closedTasks(project, from);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // The history starts at the first sign of work (activity or a task closed), so a young project is not diluted.
  const firstWork = Math.min(...activity.map((interval) => interval.from), ...closed.map((task) => task.closedAt), to);
  const start = Math.max(from, firstWork);
  const manual = manualPauses(settings);
  const auto = idleGaps(calendar, activity, start, to, settings.autoPauseHours * HOUR);
  const pauses = union([...auto, ...manual]);
  const productive = workingMs(calendar, start, to, pauses);
  const pausedHours = (totalMs(workingWindows(calendar, start, to)) - productive) / HOUR;
  const hoursPerWorkingDay = workingDayHours(calendar);

  // Effort: every agent that worked on a task of this project (builders, reviewers, testers) counts for that task.
  const effort = new Map<string, { cost: number; ms: number }>();
  for (const agent of agents) {
    if (!agent.taskRef) continue;
    const ref = shortRef(agent.taskRef);
    const entry = effort.get(ref) ?? { cost: 0, ms: 0 };
    entry.cost += agent.costUsd;
    entry.ms += Math.max(0, (agent.finishedAt ?? agent.lastActivityAt).getTime() - agent.createdAt.getTime());
    effort.set(ref, entry);
  }
  // A bulk close (a backlog cleanup: many issues at once, none worked on by an agent) is not delivered work.
  const bulk = bulkClosed(closed, effort);
  const done = closed.filter((task) => task.closedAt >= start && !bulk.has(task.ref));
  const finishedEffort = done.map((task) => ({ task, effort: effort.get(shortRef(task.ref)) ?? null, area: areaOf(task.ref) ?? 'Sem área' }));
  const measured = finishedEffort.filter((entry) => entry.effort);
  const average = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

  const areas = new Map<string, typeof finishedEffort>();
  for (const entry of finishedEffort) areas.set(entry.area, [...(areas.get(entry.area) ?? []), entry]);
  const byArea = [...areas].map(([area, entries]) => {
    const withEffort = entries.filter((entry) => entry.effort);
    return {
      area,
      tasks: entries.length,
      costPerTask: round(average(withEffort.map((entry) => entry.effort!.cost)) ?? 0),
      agentHoursPerTask: round(average(withEffort.map((entry) => entry.effort!.ms / HOUR)) ?? 0),
    };
  });

  const dailyMap = new Map<string, { done: number; cost: number }>();
  for (let at = start; at <= to; at += DAY) dailyMap.set(localDay(calendar.timeZone, at), { done: 0, cost: 0 });
  dailyMap.set(localDay(calendar.timeZone, to), dailyMap.get(localDay(calendar.timeZone, to)) ?? { done: 0, cost: 0 });
  for (const task of done) {
    const day = dailyMap.get(localDay(calendar.timeZone, task.closedAt));
    if (day) day.done += 1;
  }
  for (const agent of agents) {
    if (agent.projectId !== project.id) continue;
    const day = dailyMap.get(localDay(calendar.timeZone, agent.createdAt.getTime()));
    if (day) day.cost += agent.costUsd;
  }

  const productiveDays = productive / HOUR / hoursPerWorkingDay;
  const metrics: ProjectMetrics = {
    projectId: project.id,
    projectName: project.name,
    window: { from: new Date(start).toISOString(), to: new Date(to).toISOString() },
    calendar,
    hoursPerWorkingDay,
    productiveHours: round(productive / HOUR),
    pauses: {
      auto: auto.map(iso),
      manual: settings.pauses.map((pause) => ({ from: pause.from, to: pause.to, reason: pause.reason })),
      pausedHours: round(pausedHours),
    },
    tasksDone: done.length,
    bulkClosed: closed.filter((task) => task.closedAt >= start && bulk.has(task.ref)).length,
    tasksPerDay: done.length > 0 && productiveDays > 0 ? round(done.length / productiveDays) : null,
    costPerTask: average(measured.map((entry) => entry.effort!.cost)) === null ? null : round(average(measured.map((entry) => entry.effort!.cost))!),
    agentHoursPerTask: measured.length > 0 ? round(average(measured.map((entry) => entry.effort!.ms / HOUR))!) : null,
    totalCost: round(agents.filter((agent) => agent.projectId === project.id).reduce((sum, agent) => sum + agent.costUsd, 0)),
    byArea: byArea.sort((a, b) => b.tasks - a.tasks),
    daily: [...dailyMap].sort(([a], [b]) => a.localeCompare(b)).map(([day, entry]) => ({ day, done: entry.done, cost: round(entry.cost) })),
    error,
  };
  const value = { metrics, closedAt: new Map(closed.map((task) => [shortRef(task.ref), task.closedAt])), effort };
  cache.set(project.id, { at: Date.now(), value });
  return value;
}

/**
 * A system's metrics from its projects': they are worked on side by side, so the paces add up; costs and hours per task
 * are averaged by the tasks each project finished. The calendar and the pauses are the workspace's, the same for all.
 */
export function combineMetrics(name: string, list: ProjectMetrics[]): ProjectMetrics | null {
  if (list.length <= 1) return list[0] ?? null;
  const first = list[0]!;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const weighted = (pick: (metrics: ProjectMetrics) => number | null) => {
    const known = list.filter((metrics) => pick(metrics) !== null && metrics.tasksDone > 0);
    const tasks = sum(known.map((metrics) => metrics.tasksDone));
    return tasks > 0 ? round(sum(known.map((metrics) => pick(metrics)! * metrics.tasksDone)) / tasks) : null;
  };
  const areas = new Map<string, AreaMetrics>();
  for (const area of list.flatMap((metrics) => metrics.byArea)) {
    const entry = areas.get(area.area);
    if (!entry) {
      areas.set(area.area, { ...area });
      continue;
    }
    const tasks = entry.tasks + area.tasks;
    entry.costPerTask = round((entry.costPerTask * entry.tasks + area.costPerTask * area.tasks) / tasks);
    entry.agentHoursPerTask = round((entry.agentHoursPerTask * entry.tasks + area.agentHoursPerTask * area.tasks) / tasks);
    entry.tasks = tasks;
  }
  const daily = new Map<string, { done: number; cost: number }>();
  for (const day of list.flatMap((metrics) => metrics.daily)) {
    const entry = daily.get(day.day) ?? { done: 0, cost: 0 };
    entry.done += day.done;
    entry.cost = round(entry.cost + day.cost);
    daily.set(day.day, entry);
  }
  const paces = list.flatMap((metrics) => (metrics.tasksPerDay === null ? [] : [metrics.tasksPerDay]));
  const errors = list.filter((metrics) => metrics.error).map((metrics) => `${metrics.projectName}: ${metrics.error}`);
  return {
    ...first,
    projectName: name,
    window: { from: list.map((metrics) => metrics.window.from).sort()[0]!, to: list.map((metrics) => metrics.window.to).sort().at(-1)! },
    productiveHours: Math.max(...list.map((metrics) => metrics.productiveHours)),
    tasksDone: sum(list.map((metrics) => metrics.tasksDone)),
    bulkClosed: sum(list.map((metrics) => metrics.bulkClosed)),
    tasksPerDay: paces.length > 0 ? round(sum(paces)) : null,
    costPerTask: weighted((metrics) => metrics.costPerTask),
    agentHoursPerTask: weighted((metrics) => metrics.agentHoursPerTask),
    totalCost: round(sum(list.map((metrics) => metrics.totalCost))),
    byArea: [...areas.values()].sort((a, b) => b.tasks - a.tasks),
    daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, entry]) => ({ day, ...entry })),
    error: errors.length > 0 ? errors.join(' · ') : null,
  };
}

const BULK_GAP_MS = 10 * 60_000;
const BULK_SIZE = 10;

/**
 * Refs of the issues closed in bulk: runs of at least BULK_SIZE closings less than BULK_GAP_MS apart, none of them
 * worked on by an agent. Merges at validation close a few issues together too, but those were worked on.
 */
export function bulkClosed(closed: ClosedTask[], effort: Map<string, unknown>) {
  const sorted = [...closed].sort((a, b) => a.closedAt - b.closedAt);
  const runs: ClosedTask[][] = [];
  for (const task of sorted) {
    const run = runs.at(-1);
    if (run && task.closedAt - run.at(-1)!.closedAt < BULK_GAP_MS) run.push(task);
    else runs.push([task]);
  }
  return new Set(
    runs.filter((run) => run.length >= BULK_SIZE && run.every((task) => !effort.has(shortRef(task.ref)))).flatMap((run) => run.map((task) => task.ref)),
  );
}

const round = (value: number) => Math.round(value * 100) / 100;
const iso = (interval: Interval) => ({ from: new Date(interval.from).toISOString(), to: new Date(interval.to).toISOString() });

export function workingDayHours(calendar: WorkCalendar) {
  const [startHours, startMinutes] = calendar.start.split(':').map(Number);
  const [endHours, endMinutes] = calendar.end.split(':').map(Number);
  return (endHours! * 60 + endMinutes! - (startHours! * 60 + startMinutes!)) / 60;
}

/** Issues of the project closed since `since`, with when they closed (the provider's record, not the Studio's). */
async function closedTasks(project: Project, since: number): Promise<ClosedTask[]> {
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) return [];
  const account = await findWorkspaceGitAccount(project.workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  const sinceIso = new Date(since).toISOString();
  const tasks: ClosedTask[] = [];
  for (let page = 1; page <= 10; page += 1) {
    let url: string;
    let headers: Record<string, string>;
    if (account.provider === 'GITHUB') {
      const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`;
      url = `${apiBase}/repos/${remote.path}/issues?state=closed&since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
      headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' };
    } else {
      url = `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}/issues?state=closed&updated_after=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
      headers = { 'PRIVATE-TOKEN': token };
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!response) throw new Error(`Não foi possível conectar a ${remote.host}.`);
    if (!response.ok) throw new Error(`${account.provider === 'GITHUB' ? 'GitHub' : 'GitLab'} respondeu ${response.status} ao listar as tarefas fechadas.`);
    const issues = (await response.json()) as { number?: number; iid?: number; title: string; closed_at: string | null; pull_request?: unknown; state_reason?: string }[];
    for (const issue of issues) {
      if (issue.pull_request || !issue.closed_at) continue;
      // Closed as "not planned" (GitHub) is not delivered work.
      if (issue.state_reason === 'not_planned') continue;
      const closedAt = Date.parse(issue.closed_at);
      if (closedAt < since) continue;
      tasks.push({ ref: `${remote.path}#${issue.number ?? issue.iid}`, title: issue.title, closedAt });
    }
    if (issues.length < 100) break;
  }
  return tasks;
}
