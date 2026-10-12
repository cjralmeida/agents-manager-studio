import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import type { Project } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import { toContainerPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { type RemoteInfo, parseRemote, remoteHostname } from '../agents/remote.js';
import { boardContext } from '../boards/service.js';
import type { StatusRole } from '../boards/types.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { type RoadmapDelivery, deliveryOfTask, isPlanningTask, parseRoadmap } from './parse.js';

/**
 * The Roadmap tab: each project's docs/roadmap.md (read from the remote's base branch, where the agents merge, or from
 * the local folder when there is no remote) joined with the board tasks that carry "Entrega: N".
 */

export const ROADMAP_FILE = 'docs/roadmap.md';
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; text: string | null; error: string | null; source: 'remote' | 'local' }>();

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

/** The roadmap of every project in the workspace (projects without one come with roadmap null). */
export async function workspaceRoadmaps(workspaceId: string, refresh = false) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { projects: { where: { missingAt: null }, orderBy: { name: 'asc' } } } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const board = await boardContext(workspaceId).catch(() => null);
  const roleOf = new Map(Object.entries(board?.statusMap ?? {}).map(([role, columnId]) => [columnId, role as StatusRole]));
  const areaField = board?.snapshot.fields.find((field) => field.name.toLowerCase() === 'área' || field.name.toLowerCase() === 'area');

  return Promise.all(
    workspace.projects.map(async (project) => {
      const file = await roadmapText(workspace.name, project, refresh);
      const deliveries = file.text ? parseRoadmap(file.text) : [];
      const tasks = (board?.snapshot.items ?? [])
        .filter((item) => board!.projectOf(item) === project.id)
        .flatMap((item) => {
          const delivery = deliveryOfTask(item.body);
          if (delivery === null) return [];
          const areaOption = areaField?.options.find((option) => option.id === item.fields[areaField.id]);
          const column = board!.snapshot.columns.find((entry) => entry.id === item.columnId);
          const task: RoadmapTask & { delivery: number; planning: boolean } = {
            id: item.id,
            title: item.title,
            url: item.url,
            number: item.number,
            area: areaOption?.name ?? null,
            role: (item.columnId && roleOf.get(item.columnId)) || null,
            column: column?.name ?? null,
            isClosed: item.isClosed,
            delivery,
            planning: isPlanningTask(item.title),
          };
          return [task];
        });
      return {
        projectId: project.id,
        projectName: project.name,
        file: ROADMAP_FILE,
        source: file.source,
        error: file.error,
        roadmap: file.text === null ? null : deliveries.map((delivery) => deliveryView(delivery, tasks)),
        /** Tasks marked with a delivery the roadmap does not list (e.g. a typo in "Entrega: N"). */
        orphanTasks: tasks.filter((task) => !deliveries.some((delivery) => delivery.number === task.delivery)).map(stripTask),
      };
    }),
  );
}

function deliveryView(delivery: RoadmapDelivery, tasks: (RoadmapTask & { delivery: number; planning: boolean })[]) {
  const own = tasks.filter((task) => task.delivery === delivery.number);
  const work = own.filter((task) => !task.planning);
  const finished = work.filter(isFinished).length;
  return {
    ...delivery,
    status: deliveryStatus(work),
    progress: { done: finished, total: work.length },
    tasks: work.map(stripTask),
    planningTask: own.find((task) => task.planning) ? stripTask(own.find((task) => task.planning)!) : null,
  };
}

const isFinished = (task: RoadmapTask) => task.isClosed || task.role === 'done';

export function deliveryStatus(tasks: RoadmapTask[]): DeliveryStatus {
  if (tasks.length === 0) return 'notPlanned';
  if (tasks.every(isFinished)) return 'done';
  if (tasks.some((task) => isFinished(task) || (task.role !== null && task.role !== 'todo' && task.role !== 'blocked'))) return 'inProgress';
  return 'planned';
}

function stripTask({ id, title, url, number, area, role, column, isClosed }: RoadmapTask): RoadmapTask {
  return { id, title, url, number, area, role, column, isClosed };
}

/**
 * docs/roadmap.md text, or null when the project has none. The remote comes first; when it cannot be read (e.g. no git
 * account for its host), the local folder is used, and the remote error is reported only if that has nothing either.
 */
async function roadmapText(workspaceName: string, project: Project, refresh: boolean) {
  const cached = cache.get(project.id);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  let entry: { at: number; text: string | null; error: string | null; source: 'remote' | 'local' };
  try {
    entry = remote
      ? { at: Date.now(), text: await remoteFile(project, remote), error: null, source: 'remote' }
      : { at: Date.now(), text: await localFile(workspaceName, project.name), error: null, source: 'local' };
  } catch (error) {
    const local = await localFile(workspaceName, project.name);
    entry = { at: Date.now(), text: local, error: local === null ? (error instanceof Error ? error.message : String(error)) : null, source: 'local' };
  }
  cache.set(project.id, entry);
  return entry;
}

async function localFile(workspaceName: string, projectName: string) {
  return readFile(path.posix.join(toContainerPath(workspaceName, projectName), ROADMAP_FILE), 'utf8').catch(() => null);
}

async function remoteFile(project: Project, remote: RemoteInfo) {
  const account = await findWorkspaceGitAccount(project.workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  const ref = project.baseBranch ? `?ref=${encodeURIComponent(project.baseBranch)}` : '';
  let url: string;
  let headers: Record<string, string>;
  if (account.provider === 'GITHUB') {
    const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`;
    url = `${apiBase}/repos/${remote.path}/contents/${ROADMAP_FILE}${ref}`;
    headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'agents-manager-studio' };
  } else {
    const id = encodeURIComponent(remote.path);
    url = `https://${remote.host}/api/v4/projects/${id}/repository/files/${encodeURIComponent(ROADMAP_FILE)}/raw${ref || '?ref=HEAD'}`;
    headers = { 'PRIVATE-TOKEN': token };
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) throw new Error(`Não foi possível conectar a ${remote.host}.`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`O ${account.provider === 'GITHUB' ? 'GitHub' : 'GitLab'} respondeu ${response.status} ao ler ${ROADMAP_FILE}.`);
  return response.text();
}
