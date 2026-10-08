import { prisma } from '../../db.js';
import type { Prisma, TaskBoard } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { getStudioSettings } from '../studio-settings/service.js';
import { parseBoardUrl } from './board-url.js';
import { createGitHubClient } from './github.js';
import { createGitLabClient } from './gitlab.js';
import { detectStatusMap, sanitizeStatusMap } from './roles.js';
import { BOARD_TEMPLATE, TASK_BODY_TEMPLATE } from './template.js';
import type { BoardCandidate, BoardItem, BoardRef, BoardSnapshot, NewTask, StatusMap, StatusRole } from './types.js';

type BoardProvider = 'GITHUB' | 'GITLAB';

/** Boards are read from the provider at most this often; Studio changes update the cached copy directly. */
const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; snapshot: BoardSnapshot }>();
/** GitHub listings take a few seconds to include new items; items created here are kept until they show up. */
const RECENT_TTL_MS = 60_000;
const recentItems = new Map<string, { at: number; item: BoardItem }[]>();

// ---------------------------------------------------------------- workspace repositories

interface WorkspaceRepo {
  projectId: string;
  projectName: string;
  provider: BoardProvider;
  /** Hostname (no port), as stored on git accounts. */
  host: string;
  path: string;
}

async function workspaceRepos(workspaceId: string): Promise<WorkspaceRepo[]> {
  const projects = await prisma.project.findMany({
    where: { workspaceId, missingAt: null, isGitRepo: true, gitProvider: { in: ['GITHUB', 'GITLAB'] } },
    orderBy: { name: 'asc' },
  });
  return projects.flatMap((project) => {
    const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
    if (!remote) return [];
    return [
      {
        projectId: project.id,
        projectName: project.name,
        provider: project.gitProvider as BoardProvider,
        host: remoteHostname(remote),
        path: remote.path,
      },
    ];
  });
}

function sameRepo(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------- clients

async function clientsFor(workspaceId: string, provider: BoardProvider, host: string) {
  const account = await findWorkspaceGitAccount(workspaceId, [host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  return provider === 'GITHUB'
    ? { provider, github: createGitHubClient(host, token), gitlab: null }
    : { provider, github: null, gitlab: createGitLabClient(host, token) };
}

async function adapterFor(board: TaskBoard) {
  const clients = await clientsFor(board.workspaceId, board.provider as BoardProvider, board.host);
  return (clients.github ?? clients.gitlab)!.adapter;
}

function refOf(board: TaskBoard): BoardRef & { readme: string | null } {
  return { host: board.host, externalId: board.externalId, ownerPath: board.ownerPath, readme: board.readme };
}

async function findBoard(workspaceId: string) {
  const board = await prisma.taskBoard.findUnique({ where: { workspaceId } });
  if (!board) throw notFound('Este workspace não tem quadro de tarefas vinculado.');
  return board;
}

// ---------------------------------------------------------------- link

function linkResponse(board: TaskBoard | null) {
  if (!board) return null;
  return {
    provider: board.provider,
    host: board.host,
    ownerPath: board.ownerPath,
    title: board.title,
    url: board.url,
    statusMap: board.statusMap as StatusMap,
  };
}

export async function getBoardLink(workspaceId: string) {
  await ensureWorkspace(workspaceId);
  return linkResponse(await prisma.taskBoard.findUnique({ where: { workspaceId } }));
}

export interface CreateOption {
  provider: BoardProvider;
  host: string;
  /** GitHub organization/user or GitLab group where the board would be created. */
  owner: string;
}

/** Looks for boards of the workspace repositories, and lists where a new board could be created. */
export async function detectBoards(workspaceId: string) {
  const workspace = await ensureWorkspace(workspaceId);
  const repos = await workspaceRepos(workspaceId);
  const candidates: (BoardCandidate & { provider: BoardProvider; host: string })[] = [];
  const createOptions: CreateOption[] = [];
  const warnings: string[] = [];

  const groups = new Map<string, WorkspaceRepo[]>();
  for (const repo of repos) {
    const key = `${repo.provider}|${repo.host}`;
    groups.set(key, [...(groups.get(key) ?? []), repo]);
  }

  for (const [key, list] of groups) {
    const [provider, host] = key.split('|') as [BoardProvider, string];
    let clients;
    try {
      clients = await clientsFor(workspaceId, provider, host);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const paths = list.map((repo) => repo.path);
    const found = clients.github ? await clients.github.detect(paths, workspace.name) : await clients.gitlab!.detect(paths);
    candidates.push(...found.map((candidate) => ({ ...candidate, provider, host })));

    // GitHub boards belong to the repository owner; GitLab boards to the group holding the projects.
    const owners = paths.map((path) => (provider === 'GITHUB' ? path.split('/')[0]! : path.split('/').slice(0, -1).join('/')));
    for (const owner of new Set(owners)) createOptions.push({ provider, host, owner });
  }

  // Template-like boards first.
  candidates.sort((a, b) => Number(b.matchesTemplate) - Number(a.matchesTemplate));
  return { candidates, createOptions, warnings, defaultTitle: workspace.name };
}

async function saveLink(
  workspaceId: string,
  provider: BoardProvider,
  host: string,
  candidate: BoardCandidate,
  readme: string | null,
) {
  const data = {
    provider,
    host,
    externalId: candidate.externalId,
    ownerPath: candidate.ownerPath,
    title: candidate.title,
    url: candidate.url,
    readme,
    statusMap: {},
  };
  const board = await prisma.taskBoard.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  cache.delete(workspaceId);

  // The status map needs the columns, so it is detected on the first load.
  const snapshot = await loadSnapshot(board, true);
  const statusMap = detectStatusMap(snapshot.columns);
  const saved = await prisma.taskBoard.update({
    where: { workspaceId },
    data: { statusMap: statusMap as Prisma.InputJsonValue },
  });
  return linkResponse(saved);
}

export async function linkBoard(workspaceId: string, url: string) {
  await ensureWorkspace(workspaceId);
  const parsed = parseBoardUrl(url);
  if (!parsed) throw new HttpError(422, 'URL de quadro não reconhecida. Use a URL de um GitHub Project ou de um board de grupo do GitLab.');

  const clients = await clientsFor(workspaceId, parsed.provider, parsed.host);
  if (parsed.provider === 'GITHUB') {
    const candidate = await clients.github!.resolve(parsed);
    return saveLink(workspaceId, 'GITHUB', parsed.host, candidate, null);
  }
  const candidate = await clients.gitlab!.resolve(parsed);
  return saveLink(workspaceId, 'GITLAB', parsed.host, candidate, candidate.matchesTemplate ? BOARD_TEMPLATE.readme : null);
}

export async function createBoard(workspaceId: string, input: CreateOption & { title: string }) {
  await ensureWorkspace(workspaceId);
  const clients = await clientsFor(workspaceId, input.provider, input.host);

  if (clients.github) {
    const settings = await getStudioSettings();
    const templateUrl = settings.githubBoardTemplateUrl ? parseBoardUrl(settings.githubBoardTemplateUrl) : null;
    const template = templateUrl?.provider === 'GITHUB' ? await clients.github.resolve(templateUrl) : null;
    const repositories = (await workspaceRepos(workspaceId))
      .filter((repo) => repo.provider === 'GITHUB' && repo.host === input.host && sameRepo(repo.path.split('/')[0]!, input.owner))
      .map((repo) => repo.path);
    const { candidate, warnings } = await clients.github.create({ owner: input.owner, title: input.title, template, repositories });
    return { link: await saveLink(workspaceId, 'GITHUB', input.host, candidate, null), warnings };
  }

  const { candidate, readme } = await clients.gitlab!.create({ groupPath: input.owner, title: input.title });
  return { link: await saveLink(workspaceId, 'GITLAB', input.host, candidate, readme), warnings: [] };
}

export async function unlinkBoard(workspaceId: string) {
  await prisma.taskBoard.deleteMany({ where: { workspaceId } });
  cache.delete(workspaceId);
}

export async function updateStatusMap(workspaceId: string, map: StatusMap) {
  const board = await findBoard(workspaceId);
  const snapshot = await loadSnapshot(board, false);
  const statusMap = sanitizeStatusMap(map, snapshot.columns);
  const saved = await prisma.taskBoard.update({ where: { workspaceId }, data: { statusMap: statusMap as Prisma.InputJsonValue } });
  return linkResponse(saved);
}

// ---------------------------------------------------------------- board contents

async function loadSnapshot(board: TaskBoard, force: boolean) {
  const cached = cache.get(board.workspaceId);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snapshot;
  const adapter = await adapterFor(board);
  const snapshot = await adapter.load(refOf(board));
  const recent = (recentItems.get(board.workspaceId) ?? []).filter((entry) => Date.now() - entry.at < RECENT_TTL_MS);
  recentItems.set(board.workspaceId, recent);
  for (const { item } of recent) {
    if (!snapshot.items.some((entry) => entry.id === item.id)) snapshot.items.push(item);
  }
  cache.set(board.workspaceId, { at: Date.now(), snapshot });
  return snapshot;
}

export async function getBoard(workspaceId: string, refresh: boolean) {
  const board = await findBoard(workspaceId);
  const [snapshot, repos] = await Promise.all([loadSnapshot(board, refresh), workspaceRepos(workspaceId)]);

  const projectOf = (item: BoardItem) =>
    item.repository
      ? (repos.find((repo) => repo.provider === board.provider && repo.host === board.host && sameRepo(repo.path, item.repository!))
          ?.projectId ?? null)
      : null;

  return {
    link: linkResponse(board),
    title: snapshot.title,
    url: snapshot.url,
    readme: snapshot.readme ?? board.readme,
    columns: snapshot.columns.map(({ id, name, color, description }) => ({ id, name, color, description })),
    fields: snapshot.fields,
    items: snapshot.items.map((item) => ({ ...item, projectId: projectOf(item) })),
    supportsDrafts: snapshot.supportsDrafts,
    taskBodyTemplate: TASK_BODY_TEMPLATE,
    /** Projects whose repository lives on the board provider; tasks can be created in them. */
    repositories: repos
      .filter((repo) => repo.provider === board.provider && repo.host === board.host)
      .map((repo) => ({ projectId: repo.projectId, projectName: repo.projectName, path: repo.path })),
  };
}

async function withItem(workspaceId: string, itemId: string) {
  const board = await findBoard(workspaceId);
  const snapshot = await loadSnapshot(board, false);
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item) throw notFound('Tarefa não encontrada no quadro. Atualize o quadro e tente de novo.');
  return { board, snapshot, item };
}

export async function moveItem(workspaceId: string, itemId: string, columnId: string) {
  const { board, snapshot, item } = await withItem(workspaceId, itemId);
  if (!snapshot.columns.some((column) => column.id === columnId)) throw notFound('Coluna não encontrada.');
  await (await adapterFor(board)).moveItem(refOf(board), snapshot, itemId, columnId);
  item.columnId = columnId;
  if (board.provider === 'GITLAB') item.isClosed = columnId === 'closed';
}

export async function setItemField(workspaceId: string, itemId: string, fieldId: string, optionId: string | null) {
  const { board, snapshot, item } = await withItem(workspaceId, itemId);
  const field = snapshot.fields.find((entry) => entry.id === fieldId);
  if (!field) throw notFound('Campo não encontrado.');
  if (optionId && !field.options.some((option) => option.id === optionId)) throw notFound('Opção não encontrada.');
  await (await adapterFor(board)).setItemField(refOf(board), snapshot, itemId, fieldId, optionId);
  if (optionId) item.fields[fieldId] = optionId;
  else delete item.fields[fieldId];
}

export async function createTask(workspaceId: string, task: NewTask) {
  const board = await findBoard(workspaceId);
  const snapshot = await loadSnapshot(board, false);
  if (task.repository) {
    const repos = await workspaceRepos(workspaceId);
    if (!repos.some((repo) => repo.provider === board.provider && sameRepo(repo.path, task.repository!))) {
      throw new HttpError(422, 'O repositório escolhido não pertence a este workspace.');
    }
  } else if (!snapshot.supportsDrafts) {
    throw new HttpError(422, 'Escolha o projeto da tarefa.');
  }
  const item = await (await adapterFor(board)).createTask(refOf(board), snapshot, task);
  snapshot.items.push(item);
  recentItems.set(workspaceId, [...(recentItems.get(workspaceId) ?? []), { at: Date.now(), item }]);
  return { id: item.id };
}

// ---------------------------------------------------------------- agent automation

/**
 * Validates that an agent may work on a board item and returns what the agent records about it.
 * Items in the "blocked" column (Aguardando aprovação) are off limits for agents.
 */
export async function taskForAgent(workspaceId: string, itemId: string) {
  const { board, item } = await withItem(workspaceId, itemId);
  const statusMap = board.statusMap as StatusMap;
  if (statusMap.blocked && item.columnId === statusMap.blocked) {
    throw new HttpError(409, 'Esta tarefa está aguardando aprovação; agentes não executam itens nessa coluna.');
  }
  return {
    item,
    taskRef: item.repository && item.number ? `${item.repository}#${item.number}` : null,
    readme: (await loadSnapshot(board, false)).readme ?? board.readme,
  };
}

/** Moves the agent's task to the column of a role; failures are reported, never thrown. */
export async function moveAgentTask(
  agent: { workspaceId: string; taskItemId: string | null },
  role: StatusRole,
  options: { assignSelf?: boolean } = {},
): Promise<string | null> {
  if (!agent.taskItemId) return null;
  try {
    const board = await findBoard(agent.workspaceId);
    const columnId = (board.statusMap as StatusMap)[role];
    if (columnId) await moveItem(agent.workspaceId, agent.taskItemId, columnId);
    if (options.assignSelf) await (await adapterFor(board)).assignSelf(refOf(board), agent.taskItemId);
    const column = (await loadSnapshot(board, false)).columns.find((entry) => entry.id === columnId);
    return column ? `Tarefa movida para "${column.name}" no quadro.` : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Não foi possível atualizar o quadro: ${message}`;
  }
}

// ---------------------------------------------------------------- helpers

async function ensureWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  return workspace;
}
