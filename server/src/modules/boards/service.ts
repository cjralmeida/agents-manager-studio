import { prisma } from '../../db.js';
import { Prisma, type TaskBoard } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { getStudioSettings } from '../studio-settings/service.js';
import { parseBoardUrl } from './board-url.js';
import { createGitHubClient } from './github.js';
import { createGitLabClient } from './gitlab.js';
import { createLocalAdapter } from './local.js';
import { asStructure } from './model.js';
import { getWorkspaceModel } from './model-store.js';
import { type ModelMap, followsModel, mapByName, modelAsProviderStructure, statusMapFrom } from './model-sync.js';
import { detectStatusMap } from './roles.js';
import { type FieldOrder, GITLAB_FIXED_COLUMNS, fieldOrderOf, structureOf } from './structure.js';
import { BOARD_TEMPLATE, GITHUB_COLORS, TASK_BODY_TEMPLATE } from './template.js';
import type { BoardCandidate, BoardItem, BoardRef, BoardSnapshot, NewTask, StatusMap, StatusRole } from './types.js';

export type BoardProviderName = 'GITHUB' | 'GITLAB';

type BoardProvider = 'GITHUB' | 'GITLAB';

/** Last board read per workspace; refreshed by the board sync, and Studio changes update it directly. */
const cache = new Map<string, { at: number; snapshot: BoardSnapshot }>();
/** GitHub listings take a few seconds to include new items; items created here are kept until they show up. */
const RECENT_TTL_MS = 60_000;
const recentItems = new Map<string, { at: number; item: BoardItem }[]>();

// ---------------------------------------------------------------- workspace repositories

interface WorkspaceRepo {
  projectId: string;
  projectName: string;
  provider: BoardProvider | 'STUDIO';
  /** Hostname (no port), as stored on git accounts. */
  host: string;
  path: string;
}

/** Projects a board's tasks can belong to: the workspace git repositories, or every project for a Studio board. */
async function boardRepos(board: TaskBoard): Promise<WorkspaceRepo[]> {
  if (board.provider !== 'STUDIO') return workspaceRepos(board.workspaceId);
  const projects = await prisma.project.findMany({ where: { workspaceId: board.workspaceId, missingAt: null }, orderBy: { name: 'asc' } });
  // A Studio task's "repository" is its project name.
  return projects.map((project) => ({ projectId: project.id, projectName: project.name, provider: 'STUDIO', host: 'studio', path: project.name }));
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

export async function adapterFor(board: TaskBoard) {
  if (board.provider === 'STUDIO') return createLocalAdapter(board.workspaceId, await getWorkspaceModel(board.workspaceId));
  const clients = await clientsFor(board.workspaceId, board.provider as BoardProvider, board.host);
  return (clients.github ?? clients.gitlab)!.adapter;
}

export function refOf(board: TaskBoard): BoardRef & { readme: string | null; fieldOrder: FieldOrder | null } {
  return {
    host: board.host,
    externalId: board.externalId,
    ownerPath: board.ownerPath,
    readme: board.readme,
    fieldOrder: (board.fieldOrder as FieldOrder | null) ?? null,
  };
}

export async function findBoard(workspaceId: string) {
  const board = await prisma.taskBoard.findUnique({ where: { workspaceId } });
  if (!board) throw notFound('Este workspace não tem quadro de tarefas vinculado.');
  return board;
}

// ---------------------------------------------------------------- link

export function linkResponse(board: TaskBoard | null) {
  if (!board) return null;
  return {
    provider: board.provider,
    host: board.host,
    ownerPath: board.ownerPath,
    title: board.title,
    url: board.url,
    statusMap: board.statusMap as StatusMap,
    refreshIntervalSec: board.refreshIntervalSec,
    lastSyncedAt: board.lastSyncedAt,
    lastSyncError: board.lastSyncError,
    /** "synced", "drift" (changed on the provider) or "pending" (not converted to the model yet). */
    modelStatus: board.modelStatus as 'synced' | 'drift' | 'pending',
    modelSyncError: board.modelSyncError,
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

async function saveLink(workspaceId: string, provider: BoardProvider, host: string, candidate: BoardCandidate, readme: string | null) {
  const other = await prisma.taskBoard.findFirst({
    where: { provider, host, externalId: candidate.externalId, NOT: { workspaceId } },
    include: { workspace: { select: { name: true, ownerId: true } } },
  });
  if (other) {
    const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
    // The name of another user's workspace is not shown.
    const where = other.workspace.ownerId === ownerId ? `ao workspace "${other.workspace.name}"` : 'a outro workspace';
    throw new HttpError(409, `Este quadro já está vinculado ${where}. Um quadro só pode ser usado por um workspace.`);
  }

  const model = await getWorkspaceModel(workspaceId);
  const data = {
    provider,
    host,
    externalId: candidate.externalId,
    ownerPath: candidate.ownerPath,
    title: candidate.title,
    url: candidate.url,
    readme,
    statusMap: {},
    // GitLab sorts labels by name: fields follow the model order.
    fieldOrder: provider === 'GITLAB' ? (fieldOrderOf(asStructure(model)) as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    modelMap: Prisma.DbNull,
    modelStatus: 'pending',
    modelSyncError: null,
  };
  const board = await prisma.taskBoard.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  cache.delete(workspaceId);

  // A board already equal to the model (e.g. created by the Studio) is synced at once; others wait for the conversion,
  // with roles guessed from the column names meanwhile.
  const snapshot = await loadSnapshot(board, true);
  const current = structureOf(snapshot.columns, snapshot.fields, provider);
  const map = mapByName(model, current, provider);
  const synced = followsModel(model, current, map, provider);
  const saved = await prisma.taskBoard.update({
    where: { workspaceId },
    data: {
      statusMap: (synced ? statusMapFrom(model, map, provider) : detectStatusMap(snapshot.columns)) as Prisma.InputJsonValue,
      modelMap: synced ? (map as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      modelStatus: synced ? 'synced' : 'pending',
    },
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

/** Creates the board in the provider following the Studio model (on GitHub, over the template project when there is one). */
export async function createBoard(workspaceId: string, input: CreateOption & { title: string }) {
  await ensureWorkspace(workspaceId);
  const clients = await clientsFor(workspaceId, input.provider, input.host);
  const structure = modelAsProviderStructure(await getWorkspaceModel(workspaceId), input.provider);

  if (clients.github) {
    const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
    const settings = await getStudioSettings(ownerId);
    const templateUrl = settings.githubBoardTemplateUrl ? parseBoardUrl(settings.githubBoardTemplateUrl) : null;
    const template = templateUrl?.provider === 'GITHUB' ? await clients.github.resolve(templateUrl) : null;
    const repositories = (await workspaceRepos(workspaceId))
      .filter((repo) => repo.provider === 'GITHUB' && repo.host === input.host && sameRepo(repo.path.split('/')[0]!, input.owner))
      .map((repo) => repo.path);
    const { candidate, warnings } = await clients.github.create({ owner: input.owner, title: input.title, template, repositories, structure });
    return { link: await saveLink(workspaceId, 'GITHUB', input.host, candidate, null), warnings };
  }

  const { candidate, readme } = await clients.gitlab!.create({ groupPath: input.owner, title: input.title, structure });
  return { link: await saveLink(workspaceId, 'GITLAB', input.host, candidate, readme), warnings: [] };
}

/**
 * A board only in the Studio: it follows the model directly (same ids), so it is always in sync. Tasks stay in the
 * Studio database, also if the board is removed and created again.
 */
export async function createLocalBoard(workspaceId: string) {
  const workspace = await ensureWorkspace(workspaceId);
  if (await prisma.taskBoard.findUnique({ where: { workspaceId } })) throw new HttpError(409, 'Este workspace já tem um quadro. Desvincule-o antes.');
  const model = await getWorkspaceModel(workspaceId);
  const statusMap = Object.fromEntries(model.columns.filter((column) => column.role).map((column) => [column.role!, column.id]));
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      provider: 'STUDIO',
      host: 'studio',
      externalId: workspaceId,
      ownerPath: workspace.name,
      title: 'Quadro do Studio',
      url: `/workspaces/${workspaceId}?tab=board`,
      readme: BOARD_TEMPLATE.readme,
      statusMap: statusMap as Prisma.InputJsonValue,
      modelStatus: 'synced',
    },
  });
  cache.delete(workspaceId);
  return linkResponse(board);
}

export async function unlinkBoard(workspaceId: string) {
  await prisma.taskBoard.deleteMany({ where: { workspaceId } });
  cache.delete(workspaceId);
}

export function forgetSnapshot(workspaceId: string) {
  cache.delete(workspaceId);
}

// ---------------------------------------------------------------- board contents

/** The cached board, read from the provider only when forced or not cached yet (the board sync keeps it fresh). */
export async function loadSnapshot(board: TaskBoard, force: boolean) {
  const cached = cache.get(board.workspaceId);
  if (!force && cached) return cached.snapshot;
  const adapter = await adapterFor(board);
  const snapshot = await adapter.load(refOf(board));
  if (board.provider === 'GITLAB') {
    const model = await getWorkspaceModel(board.workspaceId);
    for (const column of snapshot.columns) {
      const role = column.id === GITLAB_FIXED_COLUMNS.first ? 'todo' : column.id === GITLAB_FIXED_COLUMNS.last ? 'done' : null;
      const modelColumn = role && model.columns.find((entry) => entry.role === role);
      if (modelColumn) Object.assign(column, { name: modelColumn.name, color: GITHUB_COLORS[modelColumn.color], description: modelColumn.description || column.description });
    }
  }
  const recent = (recentItems.get(board.workspaceId) ?? []).filter((entry) => Date.now() - entry.at < RECENT_TTL_MS);
  recentItems.set(board.workspaceId, recent);
  for (const { item } of recent) {
    if (!snapshot.items.some((entry) => entry.id === item.id)) snapshot.items.push(item);
  }
  cache.set(board.workspaceId, { at: Date.now(), snapshot });
  return snapshot;
}

/** Reads the board from the provider now and records when (or why it failed) for the UI. */
export async function syncBoard(board: TaskBoard) {
  try {
    const snapshot = await loadSnapshot(board, true);
    await prisma.taskBoard.update({
      where: { workspaceId: board.workspaceId },
      data: { lastSyncedAt: new Date(), lastSyncError: null, modelStatus: await modelStatusOf(board, snapshot) },
    });
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    await prisma.taskBoard.update({ where: { workspaceId: board.workspaceId }, data: { lastSyncError: message } }).catch(() => undefined);
    throw error;
  }
}

/** A converted board is "drift" when someone changed it on the provider; it is never reverted on its own. */
async function modelStatusOf(board: TaskBoard, snapshot: BoardSnapshot) {
  if (board.provider === 'STUDIO') return 'synced';
  if (board.modelStatus === 'pending') return 'pending';
  const provider = board.provider as BoardProvider;
  const model = await getWorkspaceModel(board.workspaceId);
  const current = structureOf(snapshot.columns, snapshot.fields, provider);
  return followsModel(model, current, board.modelMap as unknown as ModelMap | null, provider) ? 'synced' : 'drift';
}

/** Board, its cached contents and how to find the workspace project of an item (used by the workflows). */
export async function boardContext(workspaceId: string) {
  const board = await findBoard(workspaceId);
  const [snapshot, repos] = await Promise.all([loadSnapshot(board, false), boardRepos(board)]);
  const projectOf = (item: BoardItem) =>
    item.repository
      ? (repos.find((repo) => repo.provider === board.provider && repo.host === board.host && sameRepo(repo.path, item.repository!))
          ?.projectId ?? null)
      : null;
  return { board, snapshot, repos, projectOf };
}

export async function updateBoardSettings(workspaceId: string, input: { refreshIntervalSec: number }) {
  await findBoard(workspaceId);
  const saved = await prisma.taskBoard.update({ where: { workspaceId }, data: { refreshIntervalSec: input.refreshIntervalSec } });
  return linkResponse(saved);
}

export async function getBoard(workspaceId: string, refresh: boolean) {
  if (refresh) await syncBoard(await findBoard(workspaceId));
  const { board, snapshot, repos, projectOf } = await boardContext(workspaceId);

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
    const repos = await boardRepos(board);
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

export async function ensureWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  return workspace;
}
