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
import { type BoardModel, asStructure } from './model.js';
import { getWorkspaceModel } from './model-store.js';
import { type ModelMap, followsModel, mapByName, modelAsProviderStructure, statusMapFrom } from './model-sync.js';
import { itemRef, releasableItems } from './dependencies.js';
import { detectStatusMap } from './roles.js';
import { type FieldOrder, GITLAB_FIXED_COLUMNS, fieldOrderOf, structureOf } from './structure.js';
import { BOARD_TEMPLATE, GITHUB_COLORS, TASK_BODY_TEMPLATE } from './template.js';
import type { BoardCandidate, BoardItem, BoardRef, BoardSnapshot, NewTask, StatusMap, StatusRole } from './types.js';
import { type SourceMapping, joinedItemId, modelLayout, splitItemId, toJoinedItem, toSourceColumn, toSourceField, toSourceFields } from './unified.js';
import { ensureBoardWebhook, removeBoardWebhook } from '../webhooks/hooks.js';

/**
 * A workspace board joins one or more sources: GitHub Projects, GitLab group boards and the Studio's own tasks. Each
 * source is a row of task_boards and follows the board model; the joined board speaks the model (its columns, fields
 * and roles), with task ids "<source id>:<id in the source>". Reads come from a per-source cache kept fresh by the
 * board sync; changes go to the source of the task.
 */

export type BoardProviderName = 'GITHUB' | 'GITLAB';

type BoardProvider = 'GITHUB' | 'GITLAB';

/** Last read of each source; refreshed by the board sync, and Studio changes update it directly. */
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
  /** Repository path; for Studio tasks, the project name. */
  path: string;
  /** Source where new tasks of this project are created; null when no source can hold them. */
  sourceId: string | null;
}

async function gitRepos(workspaceId: string) {
  const projects = await prisma.project.findMany({
    where: { workspaceId, missingAt: null, isGitRepo: true, gitProvider: { in: ['GITHUB', 'GITLAB'] } },
    orderBy: { name: 'asc' },
  });
  return projects.flatMap((project) => {
    const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
    if (!remote) return [];
    return [{ projectId: project.id, projectName: project.name, provider: project.gitProvider as BoardProvider, host: remoteHostname(remote), path: remote.path }];
  });
}

function sameRepo(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The source that holds a git project's tasks: a GitLab group board holds the projects of its group (the deepest
 * group wins); a GitHub Project can hold any repository of its host (its owner's first).
 */
function sourceForRepo(sources: TaskBoard[], repo: { provider: BoardProvider; host: string; path: string }) {
  const candidates = sources.filter((source) => source.provider === repo.provider && source.host === repo.host);
  if (repo.provider === 'GITLAB') {
    return candidates
      .filter((source) => repo.path.toLowerCase().startsWith(`${source.ownerPath.toLowerCase()}/`))
      .sort((a, b) => b.ownerPath.length - a.ownerPath.length)[0];
  }
  const owner = repo.path.split('/')[0]!.toLowerCase();
  return candidates.find((source) => source.ownerPath.toLowerCase() === owner) ?? candidates[0];
}

/** Projects the board's tasks can belong to, each with the source where its tasks are created. */
async function boardRepos(workspaceId: string, sources: TaskBoard[]): Promise<WorkspaceRepo[]> {
  const studio = sources.find((source) => source.provider === 'STUDIO');
  const repos: WorkspaceRepo[] = (await gitRepos(workspaceId)).map((repo) => ({ ...repo, sourceId: sourceForRepo(sources, repo)?.id ?? null }));
  if (!studio) return repos;
  // Projects no provider source holds get their tasks on the Studio source (its "repository" is the project name).
  const covered = new Set(repos.filter((repo) => repo.sourceId).map((repo) => repo.projectId));
  const projects = await prisma.project.findMany({ where: { workspaceId, missingAt: null }, orderBy: { name: 'asc' } });
  for (const project of projects) {
    if (covered.has(project.id)) continue;
    repos.push({ projectId: project.id, projectName: project.name, provider: 'STUDIO', host: 'studio', path: project.name, sourceId: studio.id });
  }
  return repos;
}

// ---------------------------------------------------------------- clients

async function clientsFor(workspaceId: string, provider: BoardProvider, host: string) {
  const account = await findWorkspaceGitAccount(workspaceId, [host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  return provider === 'GITHUB'
    ? { provider, github: createGitHubClient(host, token), gitlab: null }
    : { provider, github: null, gitlab: createGitLabClient(host, token) };
}

export async function adapterFor(source: TaskBoard) {
  if (source.provider === 'STUDIO') return createLocalAdapter(source.workspaceId, await getWorkspaceModel(source.workspaceId));
  const clients = await clientsFor(source.workspaceId, source.provider as BoardProvider, source.host);
  return (clients.github ?? clients.gitlab)!.adapter;
}

export function refOf(source: TaskBoard): BoardRef & { readme: string | null; fieldOrder: FieldOrder | null } {
  return {
    host: source.host,
    externalId: source.externalId,
    ownerPath: source.ownerPath,
    readme: source.readme,
    fieldOrder: (source.fieldOrder as FieldOrder | null) ?? null,
  };
}

export function listSources(workspaceId: string) {
  return prisma.taskBoard.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function findSource(workspaceId: string, sourceId: string) {
  const source = await prisma.taskBoard.findFirst({ where: { id: sourceId, workspaceId } });
  if (!source) throw notFound('Quadro não encontrado neste workspace.');
  return source;
}

export async function hasBoard(workspaceId: string) {
  return (await prisma.taskBoard.count({ where: { workspaceId } })) > 0;
}

// ---------------------------------------------------------------- sources

export function sourceResponse(source: TaskBoard) {
  return {
    id: source.id,
    provider: source.provider,
    host: source.host,
    ownerPath: source.ownerPath,
    title: source.title,
    url: source.url,
    refreshIntervalSec: source.refreshIntervalSec,
    watchIntervalMin: source.watchIntervalMin,
    lastSyncedAt: source.lastSyncedAt,
    lastSyncError: source.lastSyncError,
    /** "synced", "drift" (changed on the provider) or "pending" (not converted to the model yet: not on the board). */
    modelStatus: source.modelStatus as 'synced' | 'drift' | 'pending',
    modelSyncError: source.modelSyncError,
  };
}

export async function getBoardSources(workspaceId: string) {
  await ensureWorkspace(workspaceId);
  return (await listSources(workspaceId)).map(sourceResponse);
}

export interface CreateOption {
  provider: BoardProvider;
  host: string;
  /** GitHub organization/user or GitLab group where the board would be created. */
  owner: string;
}

/** Looks for boards of the workspace repositories (not linked yet), and lists where a new board could be created. */
export async function detectBoards(workspaceId: string) {
  const workspace = await ensureWorkspace(workspaceId);
  const [repos, sources] = await Promise.all([gitRepos(workspaceId), listSources(workspaceId)]);
  const candidates: (BoardCandidate & { provider: BoardProvider; host: string })[] = [];
  const createOptions: CreateOption[] = [];
  const warnings: string[] = [];

  const groups = new Map<string, typeof repos>();
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
    const linked = (candidate: BoardCandidate) => sources.some((source) => source.provider === provider && source.host === host && source.externalId === candidate.externalId);
    candidates.push(...found.filter((candidate) => !linked(candidate)).map((candidate) => ({ ...candidate, provider, host })));

    // GitHub boards belong to the repository owner; GitLab boards to the group holding the projects.
    const owners = paths.map((path) => (provider === 'GITHUB' ? path.split('/')[0]! : path.split('/').slice(0, -1).join('/')));
    for (const owner of new Set(owners)) createOptions.push({ provider, host, owner });
  }

  // Template-like boards first.
  candidates.sort((a, b) => Number(b.matchesTemplate) - Number(a.matchesTemplate));
  return { candidates, createOptions, warnings, defaultTitle: workspace.name };
}

/** Adds a provider board as a source of the workspace board. */
async function saveSource(workspaceId: string, provider: BoardProvider, host: string, candidate: BoardCandidate, readme: string | null) {
  const existing = await prisma.taskBoard.findFirst({
    where: { provider, host, externalId: candidate.externalId },
    include: { workspace: { select: { name: true, ownerId: true } } },
  });
  if (existing?.workspaceId === workspaceId) throw new HttpError(409, 'Este quadro já faz parte do quadro deste workspace.');
  if (existing) {
    const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
    // The name of another user's workspace is not shown.
    const where = existing.workspace.ownerId === ownerId ? `ao workspace "${existing.workspace.name}"` : 'a outro workspace';
    throw new HttpError(409, `Este quadro já está vinculado ${where}. Um quadro só pode ser usado por um workspace.`);
  }

  const model = await getWorkspaceModel(workspaceId);
  const source = await prisma.taskBoard.create({
    data: {
      workspaceId,
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
      modelStatus: 'pending',
    },
  });

  // A board already equal to the model (e.g. created by the Studio) joins at once; others wait for the conversion.
  const snapshot = await loadSnapshot(source, true);
  const current = structureOf(snapshot.columns, snapshot.fields, provider);
  const map = mapByName(model, current, provider);
  const synced = followsModel(model, current, map, provider);
  const saved = await prisma.taskBoard.update({
    where: { id: source.id },
    data: {
      statusMap: (synced ? statusMapFrom(model, map, provider) : detectStatusMap(snapshot.columns)) as Prisma.InputJsonValue,
      modelMap: synced ? (map as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      modelStatus: synced ? 'synced' : 'pending',
    },
  });
  // The provider tells the Studio when a task changes (in the background: the board is linked either way).
  void ensureBoardWebhook(saved).catch(() => undefined);
  return sourceResponse(saved);
}

export async function linkBoard(workspaceId: string, url: string) {
  await ensureWorkspace(workspaceId);
  const parsed = parseBoardUrl(url);
  if (!parsed) throw new HttpError(422, 'URL de quadro não reconhecida. Use a URL de um GitHub Project ou de um board de grupo do GitLab.');

  const clients = await clientsFor(workspaceId, parsed.provider, parsed.host);
  if (parsed.provider === 'GITHUB') {
    const candidate = await clients.github!.resolve(parsed);
    return saveSource(workspaceId, 'GITHUB', parsed.host, candidate, null);
  }
  const candidate = await clients.gitlab!.resolve(parsed);
  return saveSource(workspaceId, 'GITLAB', parsed.host, candidate, candidate.matchesTemplate ? BOARD_TEMPLATE.readme : null);
}

/** Creates a board in the provider following the Studio model (on GitHub, over the template project when there is one). */
export async function createBoard(workspaceId: string, input: CreateOption & { title: string }) {
  await ensureWorkspace(workspaceId);
  const clients = await clientsFor(workspaceId, input.provider, input.host);
  const structure = modelAsProviderStructure(await getWorkspaceModel(workspaceId), input.provider);

  if (clients.github) {
    const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
    const settings = await getStudioSettings(ownerId);
    const templateUrl = settings.githubBoardTemplateUrl ? parseBoardUrl(settings.githubBoardTemplateUrl) : null;
    const template = templateUrl?.provider === 'GITHUB' ? await clients.github.resolve(templateUrl) : null;
    const repositories = (await gitRepos(workspaceId))
      .filter((repo) => repo.provider === 'GITHUB' && repo.host === input.host && sameRepo(repo.path.split('/')[0]!, input.owner))
      .map((repo) => repo.path);
    const { candidate, warnings } = await clients.github.create({ owner: input.owner, title: input.title, template, repositories, structure });
    return { link: await saveSource(workspaceId, 'GITHUB', input.host, candidate, null), warnings };
  }

  const { candidate, readme } = await clients.gitlab!.create({ groupPath: input.owner, title: input.title, structure });
  return { link: await saveSource(workspaceId, 'GITLAB', input.host, candidate, readme), warnings: [] };
}

/**
 * A new GitHub repository gets its own board view (named after the project, filtered to it) on the workspace's
 * GitHub projects of the same owner. Returns problems as warnings: the project is already created.
 */
export async function addProjectBoardViews(workspaceId: string, input: { host: string; repositoryPath: string; name: string }) {
  const owner = input.repositoryPath.split('/')[0]!.toLowerCase();
  const sources = (await listSources(workspaceId)).filter(
    (source) => source.provider === 'GITHUB' && source.host === input.host && source.ownerPath.toLowerCase() === owner,
  );
  const warnings: string[] = [];
  for (const source of sources) {
    try {
      const { github } = await clientsFor(workspaceId, 'GITHUB', source.host);
      await github!.addRepositoryView(source.externalId, input.repositoryPath, input.name);
    } catch (error) {
      warnings.push(`Quadro "${source.title}": ${error instanceof Error ? error.message : 'erro'}`);
    }
  }
  return warnings;
}

/**
 * The Studio's own tasks as a source: it follows the model directly (same ids), so it is always in sync. It holds the
 * projects no provider board holds. Tasks stay in the Studio database, also if the source is removed and added again.
 */
export async function createLocalBoard(workspaceId: string) {
  const workspace = await ensureWorkspace(workspaceId);
  if (await prisma.taskBoard.findFirst({ where: { workspaceId, provider: 'STUDIO' } })) {
    throw new HttpError(409, 'Este workspace já tem tarefas do Studio no quadro.');
  }
  const model = await getWorkspaceModel(workspaceId);
  const source = await prisma.taskBoard.create({
    data: {
      workspaceId,
      provider: 'STUDIO',
      host: 'studio',
      externalId: workspaceId,
      ownerPath: workspace.name,
      title: 'Tarefas do Studio',
      url: `/workspaces/${workspaceId}?tab=board`,
      readme: BOARD_TEMPLATE.readme,
      statusMap: modelLayout(model).statusMap as Prisma.InputJsonValue,
      modelStatus: 'synced',
    },
  });
  return sourceResponse(source);
}

export async function unlinkSource(workspaceId: string, sourceId: string) {
  const source = await findSource(workspaceId, sourceId);
  await removeBoardWebhook(source);
  await prisma.taskBoard.delete({ where: { id: source.id } });
  forgetSnapshot(source.id);
}

export function forgetSnapshot(sourceId: string) {
  cache.delete(sourceId);
}

// ---------------------------------------------------------------- reading sources

/** The cached source, read from the provider only when forced or not cached yet (the board sync keeps it fresh). */
export async function loadSnapshot(source: TaskBoard, force: boolean) {
  const cached = cache.get(source.id);
  if (!force && cached) return cached.snapshot;
  const adapter = await adapterFor(source);
  const snapshot = await adapter.load(refOf(source));
  if (source.provider === 'GITLAB') {
    const model = await getWorkspaceModel(source.workspaceId);
    for (const column of snapshot.columns) {
      const role = column.id === GITLAB_FIXED_COLUMNS.first ? 'todo' : column.id === GITLAB_FIXED_COLUMNS.last ? 'done' : null;
      const modelColumn = role && model.columns.find((entry) => entry.role === role);
      if (modelColumn) Object.assign(column, { name: modelColumn.name, color: GITHUB_COLORS[modelColumn.color], description: modelColumn.description || column.description });
    }
  }
  const recent = (recentItems.get(source.id) ?? []).filter((entry) => Date.now() - entry.at < RECENT_TTL_MS);
  recentItems.set(source.id, recent);
  for (const { item } of recent) {
    if (!snapshot.items.some((entry) => entry.id === item.id)) snapshot.items.push(item);
  }
  cache.set(source.id, { at: Date.now(), snapshot });
  return snapshot;
}

/** Reads a source from the provider now and records when (or why it failed) for the UI. */
export async function syncSource(source: TaskBoard) {
  try {
    const snapshot = await loadSnapshot(source, true);
    await prisma.taskBoard.update({
      where: { id: source.id },
      data: { lastSyncedAt: new Date(), lastSyncError: null, modelStatus: await modelStatusOf(source, snapshot) },
    });
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    await prisma.taskBoard.update({ where: { id: source.id }, data: { lastSyncError: message } }).catch(() => undefined);
    throw error;
  }
}

/** Reads every source of the workspace (failures are recorded per source), then releases the tasks now unblocked. */
export async function syncWorkspaceBoard(workspaceId: string, onlyDue = false) {
  const now = Date.now();
  const sources = (await listSources(workspaceId)).filter(
    (source) => !onlyDue || !source.lastSyncedAt || now - source.lastSyncedAt.getTime() >= source.refreshIntervalSec * 1000,
  );
  const errors: string[] = [];
  for (const source of sources) {
    await syncSource(source).catch((error: unknown) => errors.push(`${source.title}: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (sources.length > 0) await releaseDependents(workspaceId).catch(() => undefined);
  return { synced: sources.length, errors };
}

/** A converted source is "drift" when someone changed it on the provider; it is never reverted on its own. */
async function modelStatusOf(source: TaskBoard, snapshot: BoardSnapshot) {
  if (source.provider === 'STUDIO') return 'synced';
  if (source.modelStatus === 'pending') return 'pending';
  const provider = source.provider as BoardProvider;
  const model = await getWorkspaceModel(source.workspaceId);
  const current = structureOf(snapshot.columns, snapshot.fields, provider);
  return followsModel(model, current, source.modelMap as unknown as ModelMap | null, provider) ? 'synced' : 'drift';
}

/** Studio sources map 1:1 to the model; provider sources through the map recorded at the conversion. */
function mappingOf(source: TaskBoard): SourceMapping {
  return { provider: source.provider as SourceMapping['provider'], modelMap: source.modelMap as unknown as ModelMap | null };
}

/** Whether the source's tasks can be on the joined board (it follows the model). */
function joinable(source: TaskBoard) {
  return source.provider === 'STUDIO' || (source.modelStatus !== 'pending' && source.modelMap !== null);
}

// ---------------------------------------------------------------- the joined board

export interface JoinedBoard {
  sources: TaskBoard[];
  model: BoardModel;
  /** The model's columns and fields, with the tasks of every source (joined ids, model column and fields). */
  snapshot: BoardSnapshot;
  /** Model column of each agent role. */
  statusMap: StatusMap;
  repos: WorkspaceRepo[];
  projectOf: (item: BoardItem) => string | null;
  /** Sources left out of the board, and why (not converted to the model yet, or unreadable). */
  excluded: { sourceId: string; title: string; reason: string }[];
}

/** The workspace board with the tasks of all its sources (used by the board view, the agents and the workflows). */
export async function boardContext(workspaceId: string): Promise<JoinedBoard> {
  const sources = await listSources(workspaceId);
  if (sources.length === 0) throw notFound('Este workspace não tem quadro de tarefas vinculado.');
  const [model, repos] = await Promise.all([getWorkspaceModel(workspaceId), boardRepos(workspaceId, sources)]);
  const layout = modelLayout(model);
  const items: BoardItem[] = [];
  const excluded: JoinedBoard['excluded'] = [];
  let readme: string | null = null;
  let supportsDrafts = false;
  const allOpenListed = new Set<string>();

  for (const source of sources) {
    if (!joinable(source)) {
      excluded.push({ sourceId: source.id, title: source.title, reason: 'Ainda não foi convertido para o modelo do quadro.' });
      continue;
    }
    let snapshot: BoardSnapshot;
    try {
      snapshot = await loadSnapshot(source, false);
    } catch (error) {
      excluded.push({ sourceId: source.id, title: source.title, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    readme ??= snapshot.readme ?? source.readme;
    supportsDrafts ||= snapshot.supportsDrafts;
    for (const item of snapshot.items) items.push(toJoinedItem(source.id, mappingOf(source), model, item));
    if (source.provider === 'GITLAB') for (const item of snapshot.items) if (item.repository) allOpenListed.add(item.repository.toLowerCase());
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const projectOf = (item: BoardItem) => {
    const source = item.sourceId ? sourceById.get(item.sourceId) : undefined;
    if (!source || !item.repository) return null;
    const match = repos.find((repo) =>
      source.provider === 'STUDIO'
        ? repo.sourceId === source.id && sameRepo(repo.path, item.repository!)
        : repo.provider === source.provider && repo.host === source.host && sameRepo(repo.path, item.repository!),
    );
    return match?.projectId ?? null;
  };

  return {
    sources,
    model,
    snapshot: {
      title: 'Quadro de tarefas',
      url: '',
      readme: readme ?? BOARD_TEMPLATE.readme,
      columns: layout.columns,
      statusFieldId: null,
      fields: layout.fields,
      items,
      supportsDrafts,
      allOpenListed: [...allOpenListed],
    },
    statusMap: layout.statusMap,
    repos,
    projectOf,
    excluded,
  };
}

export async function updateBoardSettings(workspaceId: string, input: { refreshIntervalSec?: number; watchIntervalMin?: number }) {
  await prisma.taskBoard.updateMany({ where: { workspaceId }, data: input });
  return getBoardSources(workspaceId);
}

export async function getBoard(workspaceId: string, refresh: boolean) {
  if (refresh) await syncWorkspaceBoard(workspaceId);
  const { sources, snapshot, statusMap, repos, projectOf, excluded } = await boardContext(workspaceId);
  return {
    sources: sources.map(sourceResponse),
    statusMap,
    readme: snapshot.readme,
    columns: snapshot.columns,
    fields: snapshot.fields,
    items: snapshot.items.map((item) => ({ ...item, projectId: projectOf(item) })),
    supportsDrafts: snapshot.supportsDrafts,
    excluded,
    taskBodyTemplate: TASK_BODY_TEMPLATE,
    /** Projects whose tasks can be created on the board, and in which source. */
    repositories: repos
      .filter((repo) => repo.sourceId)
      .map((repo) => ({ projectId: repo.projectId, projectName: repo.projectName, path: repo.path, sourceId: repo.sourceId! })),
  };
}

// ---------------------------------------------------------------- changing tasks

/** A task of the joined board: its source, the source's cached read and the task as the source knows it. */
async function withItem(workspaceId: string, joinedId: string) {
  const ids = splitItemId(joinedId);
  const missing = () => notFound('Tarefa não encontrada no quadro. Atualize o quadro e tente de novo.');
  if (!ids) throw missing();
  const source = await prisma.taskBoard.findFirst({ where: { id: ids.sourceId, workspaceId } });
  if (!source) throw missing();
  const snapshot = await loadSnapshot(source, false);
  const item = snapshot.items.find((entry) => entry.id === ids.itemId);
  if (!item) throw missing();
  return { source, snapshot, item, model: await getWorkspaceModel(workspaceId) };
}

/** Moves a task to a model column; reaching "done" or "homologation" may release tasks that depended on it. */
export async function moveItem(workspaceId: string, joinedId: string, modelColumnId: string) {
  const { source, snapshot, item, model } = await withItem(workspaceId, joinedId);
  const column = toSourceColumn(mappingOf(source), model, modelColumnId);
  if (!column) throw new HttpError(422, `O quadro "${source.title}" não tem essa coluna. Sincronize-o com o modelo.`);
  await (await adapterFor(source)).moveItem(refOf(source), snapshot, item.id, column);
  item.columnId = column;
  if (source.provider === 'GITLAB') item.isClosed = column === GITLAB_FIXED_COLUMNS.last;
  const statusMap = modelLayout(model).statusMap;
  if (modelColumnId === statusMap.done || modelColumnId === statusMap.homologation) await releaseDependents(workspaceId);
}

/** New title and/or description of a task (the task agent keeps tasks that did not start up to date). */
export async function editItem(workspaceId: string, joinedId: string, changes: { title?: string; body?: string }) {
  const { source, snapshot, item } = await withItem(workspaceId, joinedId);
  await (await adapterFor(source)).editItem(refOf(source), snapshot, item.id, changes);
  Object.assign(item, changes);
}

/** Replaces who is assigned to the task on its provider (usernames; empty removes everyone). */
export async function setItemAssignees(workspaceId: string, joinedId: string, usernames: string[]) {
  const { source, item } = await withItem(workspaceId, joinedId);
  await (await adapterFor(source)).setAssignees(refOf(source), item.id, usernames);
  item.assignees = usernames;
}

/** Closes or reopens the task's issue on its provider. */
export async function setItemClosed(workspaceId: string, joinedId: string, closed: boolean) {
  const { source, item } = await withItem(workspaceId, joinedId);
  await (await adapterFor(source)).setClosed(refOf(source), item.id, closed);
  item.isClosed = closed;
}

/** Sets (or clears) a model field of a task. */
export async function setItemField(workspaceId: string, joinedId: string, modelFieldId: string, modelOptionId: string | null) {
  const { source, snapshot, item, model } = await withItem(workspaceId, joinedId);
  const field = model.fields.find((entry) => entry.id === modelFieldId);
  if (!field) throw notFound('Campo não encontrado.');
  if (modelOptionId && !field.options.some((option) => option.id === modelOptionId)) throw notFound('Opção não encontrada.');
  const target = toSourceField(mappingOf(source), modelFieldId, modelOptionId);
  if (!target) throw new HttpError(422, `O quadro "${source.title}" não tem esse campo ou opção. Sincronize-o com o modelo.`);
  await (await adapterFor(source)).setItemField(refOf(source), snapshot, item.id, target.fieldId, target.optionId);
  if (target.optionId) item.fields[target.fieldId] = target.optionId;
  else delete item.fields[target.fieldId];
}

/**
 * Creates a task in the source that holds its project (model column and fields translated to that source).
 * Without a project, it is a draft on a source that supports drafts (the Studio's tasks first, then GitHub).
 */
export async function createTask(workspaceId: string, task: NewTask) {
  const sources = (await listSources(workspaceId)).filter(joinable);
  if (sources.length === 0) throw new HttpError(422, 'O quadro deste workspace ainda não segue o modelo.');
  let source: TaskBoard | undefined;
  if (task.repository) {
    const repo = (await boardRepos(workspaceId, sources)).find((entry) => entry.sourceId && sameRepo(entry.path, task.repository!));
    if (!repo) throw new HttpError(422, 'Nenhum quadro deste workspace guarda tarefas desse projeto.');
    source = sources.find((entry) => entry.id === repo.sourceId);
  } else {
    source = sources.find((entry) => entry.provider === 'STUDIO') ?? sources.find((entry) => entry.provider === 'GITHUB');
    if (!source) throw new HttpError(422, 'Escolha o projeto da tarefa.');
  }
  const model = await getWorkspaceModel(workspaceId);
  const mapping = mappingOf(source!);
  const snapshot = await loadSnapshot(source!, false);
  const item = await (await adapterFor(source!)).createTask(refOf(source!), snapshot, {
    ...task,
    columnId: task.columnId ? toSourceColumn(mapping, model, task.columnId) : null,
    fields: toSourceFields(mapping, task.fields),
  });
  snapshot.items.push(item);
  recentItems.set(source!.id, [...(recentItems.get(source!.id) ?? []), { at: Date.now(), item }]);
  return { id: joinedItemId(source!.id, item.id) };
}

/**
 * Blocked tasks ("Depende de: org/repo#12") go to "todo" once all their dependencies are delivered. Runs after every
 * board sync and whenever the Studio moves a task to "done"/"homologation"; dependencies may be on another source.
 */
export async function releaseDependents(workspaceId: string) {
  const { snapshot, statusMap } = await boardContext(workspaceId);
  const released: string[] = [];
  for (const item of releasableItems(snapshot.items, statusMap, snapshot.fields, snapshot.allOpenListed)) {
    await moveItem(workspaceId, item.id, statusMap.todo!);
    released.push(itemRef(item) ?? item.title);
  }
  // A closed issue keeps its project status on GitHub (closing does not move the card): it would stay in "A fazer"
  // or the Backlog as if it were still to do. It goes to done.
  if (statusMap.done) {
    for (const item of snapshot.items.filter((entry) => entry.isClosed && entry.columnId !== statusMap.done)) {
      await moveItem(workspaceId, item.id, statusMap.done).catch(() => undefined);
    }
  }
  return released;
}

// ---------------------------------------------------------------- agent automation

/**
 * Validates that an agent may work on a board item and returns what the agent records about it.
 * Items in the "blocked" column (Backlog) are off limits for agents.
 */
export async function taskForAgent(workspaceId: string, itemId: string) {
  const { snapshot, statusMap } = await boardContext(workspaceId);
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item) throw notFound('Tarefa não encontrada no quadro. Atualize o quadro e tente de novo.');
  if (statusMap.blocked && item.columnId === statusMap.blocked) {
    throw new HttpError(409, 'Esta tarefa está aguardando aprovação; agentes não executam itens nessa coluna.');
  }
  return {
    item,
    taskRef: item.repository && item.number ? `${item.repository}#${item.number}` : null,
    readme: snapshot.readme,
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
    const model = await getWorkspaceModel(agent.workspaceId);
    const columnId = modelLayout(model).statusMap[role];
    if (columnId) await moveItem(agent.workspaceId, agent.taskItemId, columnId);
    if (options.assignSelf) {
      const { source, item } = await withItem(agent.workspaceId, agent.taskItemId);
      await (await adapterFor(source)).assignSelf(refOf(source), item.id);
    }
    const column = model.columns.find((entry) => entry.id === columnId);
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
