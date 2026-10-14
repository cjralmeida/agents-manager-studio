import { prisma } from '../../db.js';
import { parseRemote } from '../agents/remote.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { boardContext, createTask, editItem, moveItem, setItemField } from '../boards/service.js';
import type { BoardItem, BoardSnapshot } from '../boards/types.js';
import { findByName, resolveColumn, resolveFields } from './resolve.js';
import { RENDER_READ_TOOLS, RENDER_TOOL_NAMES, type RenderToolName, runRenderTool } from '../render/agent-tools.js';
import { CLICKUP_TOOL_NAMES, type ClickupToolName, runClickupTool } from '../clickup/service.js';
import { createProject, listRepositoryOwners } from '../workspaces/create-project.js';
import { runStudioTool } from './studio.js';
import { QUALITY_STATUSES, type QualityStatus, listQuality, logOccurrence, updateCategory } from '../quality/service.js';

/** Tools the runner can call for an agent; board tools need the "board" group on the agent. */
export const AGENT_TOOL_NAMES = [
  'report_result',
  'board_list_tasks',
  'board_get_task',
  'board_create_task',
  'board_update_task',
  'quality_list',
  'quality_log',
  'quality_update',
  'studio_context',
  'studio_list_runs',
  'studio_list_executions',
  'studio_get_execution',
  'studio_usage',
  'studio_propose',
  'project_owners',
  'project_create',
  'project_use',
  'studio_board_options',
  'studio_render_services',
  ...RENDER_TOOL_NAMES,
  ...CLICKUP_TOOL_NAMES,
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** What a workflow reads from an agent: its reported outcome and the tasks it created. */
export interface AgentResult {
  status?: 'success' | 'failure';
  summary?: string;
  details?: string;
  createdTasks?: { id: string; title: string; ref: string | null; url: string | null }[];
  /** Project the agent created (the next workflow steps work on it). */
  projectId?: string;
  /** The work was approved but its PR/MR conflicts with the base branch (set by the Studio, not the agent). */
  mergeConflict?: boolean;
}

type Args = Record<string, unknown>;

const text = (value: unknown, max = 60_000) => (typeof value === 'string' ? value.slice(0, max) : undefined);

function describeItem(snapshot: BoardSnapshot, item: BoardItem, withBody = false) {
  const fields = Object.fromEntries(
    snapshot.fields.flatMap((field) => {
      const option = field.options.find((entry) => entry.id === item.fields[field.id]);
      return option ? [[field.name, option.name]] : [];
    }),
  );
  return {
    id: item.id,
    ref: item.repository && item.number ? `${item.repository}#${item.number}` : null,
    title: item.title,
    column: snapshot.columns.find((column) => column.id === item.columnId)?.name ?? null,
    repository: item.repository,
    fields,
    assignees: item.assignees,
    url: item.url,
    ...(withBody && { body: item.body }),
  };
}

async function mergeResult(agentId: string, patch: AgentResult) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { result: true } });
  const current = (agent.result ?? {}) as AgentResult;
  const next: AgentResult = {
    ...current,
    ...patch,
    ...(patch.createdTasks && { createdTasks: [...(current.createdTasks ?? []), ...patch.createdTasks] }),
  };
  await prisma.agent.update({ where: { id: agentId }, data: { result: next as Prisma.InputJsonValue } });
}

/**
 * Board task from names (repository, column, "Campo": "opção"), as agents and Órbi write it.
 * Throws a message the agent can act on when a name does not exist.
 */
/** "owner/repo" of a project's remote, or null without one. */
async function projectRepository(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { gitRemoteUrl: true } });
  return project?.gitRemoteUrl ? (parseRemote(project.gitRemoteUrl)?.path ?? null) : null;
}

export async function prepareTaskByNames(workspaceId: string, args: Args) {
  const { snapshot, repos: allRepos } = await boardContext(workspaceId);
  // Only projects some source of the board holds can get tasks.
  const repos = allRepos.filter((repo) => repo.sourceId);
  const title = text(args.title, 250);
  if (!title) throw new HttpError(400, 'Informe o título da tarefa.');
  const repositoryName = text(args.repository);
  const repository = repositoryName
    ? (repos.find((repo) => repo.path.toLowerCase() === repositoryName.toLowerCase()) ??
      findByName(repos.map((repo) => ({ ...repo, name: repo.projectName })), repositoryName))
    : null;
  if (repositoryName && !repository) {
    throw new HttpError(422, `Repositório "${repositoryName}" não é do workspace. Repositórios: ${repos.map((repo) => repo.path).join(', ')}.`);
  }
  const { resolved, errors } = resolveFields(snapshot.fields, (args.fields ?? {}) as Record<string, string>);
  if (errors.length > 0) throw new HttpError(422, errors.join(' '));
  const column = text(args.column) ? resolveColumn(snapshot.columns, text(args.column)!) : null;
  // A new task has no value to clear: empty values are left out.
  const fields = Object.fromEntries(Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== null));
  return { title, body: text(args.body) ?? '', repository: repository?.path ?? null, columnId: column?.id ?? null, fields };
}

/**
 * Project tools: where a repository can be created, and creating it (a private repository with the workspace git
 * account, plus the project folder). The agent asks the user before creating; the new project goes to the result,
 * so the next workflow steps work on it.
 */
async function runProjectTool(agent: { id: string; workspaceId: string }, name: string, args: Args) {
  if (name === 'project_use') {
    // An existing project (e.g. a game being revised): the next workflow steps work on it, as with a new one.
    const projectName = text(args.name, 100)?.trim().toLowerCase();
    const projects = await prisma.project.findMany({ where: { workspaceId: agent.workspaceId }, select: { id: true, name: true } });
    const project = projects.find((entry) => entry.name.toLowerCase() === projectName);
    if (!project) throw new HttpError(404, `Projeto "${args.name}" não existe no workspace. Projetos: ${projects.map((entry) => entry.name).join(', ')}.`);
    await mergeResult(agent.id, { projectId: project.id });
    return { projectId: project.id, name: project.name, message: 'Projeto escolhido. Os próximos passos do workflow trabalham nele.' };
  }
  const { accounts } = await listRepositoryOwners(agent.workspaceId);
  if (name === 'project_owners') {
    return { accounts: accounts.map((account) => ({ account: account.label, provider: account.provider, owners: account.owners.map((owner) => ({ owner: owner.path, kind: owner.kind })) })) };
  }
  const projectName = text(args.name, 100)?.trim();
  if (!projectName) throw new HttpError(400, 'Informe o nome do projeto (será a pasta e o repositório).');
  const owner = text(args.owner, 200)?.trim();
  const account = accounts.find((entry) => entry.owners.some((candidate) => candidate.path === owner)) ?? (owner ? undefined : accounts[0]);
  if (!account) throw new HttpError(422, `"${owner}" não é um lugar onde a conta git do workspace cria repositórios. Use project_owners.`);
  const created = await createProject(agent.workspaceId, {
    name: projectName,
    description: text(args.description, 300),
    remote: { accountId: account.accountId, owner: owner || account.owners[0]!.path, visibility: 'private' },
  });
  if (created.projectId) await mergeResult(agent.id, { projectId: created.projectId });
  return { ...created, message: 'Projeto criado (repositório privado). Os próximos passos do workflow trabalham nele.' };
}

/** Runs a tool for an agent. Problems the agent can fix are thrown as messages it will read. */
export async function runAgentTool(agentId: string, name: AgentToolName, args: Args) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  if (name === 'report_result') {
    const status = args.status === 'failure' ? 'failure' : 'success';
    const summary = text(args.summary, 20_000) ?? '';
    await mergeResult(agentId, { status, summary, details: text(args.details) });
    return { ok: true, message: 'Resultado registrado. Encerre com um resumo curto.' };
  }

  if (name.startsWith('project_')) {
    if (!agent.tools.includes('projects')) throw new HttpError(403, 'Este agente não pode criar projetos.');
    return runProjectTool(agent, name, args);
  }

  if (name.startsWith('clickup_')) {
    if (!agent.tools.includes('clickup_read')) throw new HttpError(403, 'Este agente não tem acesso ao ClickUp.');
    return runClickupTool(agent, name as ClickupToolName, args);
  }

  if (name.startsWith('render_')) {
    const allowed = agent.tools.includes('render') || (agent.tools.includes('render_read') && RENDER_READ_TOOLS.includes(name));
    if (!allowed) throw new HttpError(403, 'Este agente não tem acesso a esta ferramenta do Render.');
    return runRenderTool(agent, name as RenderToolName, args);
  }

  if (name.startsWith('studio_')) {
    if (!agent.tools.includes('studio')) throw new HttpError(403, 'Ferramenta exclusiva do Órbi.');
    return runStudioTool(agent.id, agent.workspaceId, name, args);
  }

  if (name.startsWith('quality_')) {
    if (!agent.tools.includes('board')) throw new HttpError(403, 'Este agente não tem acesso ao registro de defeitos.');
    if (name === 'quality_list') return { categories: await listQuality(agent.workspaceId) };
    if (name === 'quality_log') {
      const profile = agent.profileId ? await prisma.agentProfile.findUnique({ where: { id: agent.profileId }, select: { name: true } }) : null;
      return logOccurrence(agent.workspaceId, {
        category: text(args.category, 200) ?? '',
        task: text(args.task, 300) ?? '',
        expected: text(args.expected, 2000) ?? '',
        obtained: text(args.obtained, 2000) ?? '',
        reviewer: profile?.name ?? null,
        agentId: agent.id,
      });
    }
    const status = text(args.status) as QualityStatus | undefined;
    if (status && !QUALITY_STATUSES.includes(status)) throw new HttpError(400, `Situação inválida. Use: ${QUALITY_STATUSES.join(', ')}.`);
    return updateCategory(agent.workspaceId, { category: text(args.category, 200), status, transversalRef: text(args.transversalRef, 300) });
  }

  if (!agent.tools.includes('board') && !agent.tools.includes('board_read')) {
    throw new HttpError(403, 'Este agente não tem acesso ao quadro de tarefas.');
  }
  const { snapshot, repos } = await boardContext(agent.workspaceId);
  const findItem = (id: unknown) => {
    const item = snapshot.items.find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, `Tarefa "${String(id)}" não encontrada. Use board_list_tasks para ver os ids.`);
    return item;
  };

  switch (name) {
    case 'board_list_tasks': {
      const column = text(args.column) ? resolveColumn(snapshot.columns, text(args.column)!) : null;
      const search = text(args.search)?.toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const items = snapshot.items
        .filter((item) => !column || item.columnId === column.id)
        .filter((item) => !search || `${item.title} ${item.body}`.toLowerCase().includes(search))
        .slice(0, limit);
      return {
        columns: snapshot.columns.map((entry) => entry.name),
        fields: Object.fromEntries(snapshot.fields.map((field) => [field.name, field.options.map((option) => option.name)])),
        repositories: repos.filter((repo) => repo.sourceId).map((repo) => repo.path),
        tasks: items.map((item) => describeItem(snapshot, item)),
      };
    }

    case 'board_get_task':
      return describeItem(snapshot, findItem(args.id), true);

    case 'board_create_task': {
      if (!agent.tools.includes('board')) throw new HttpError(403, 'Este agente só pode consultar o quadro.');
      // A retry after an error in the middle of a creation (e.g. the issue was created but setting a field failed)
      // must not open the same task twice: an open task with the same title in the same repository is returned.
      const wanted = text(args.title, 250)?.trim().toLowerCase();
      const repository = text(args.repository)?.toLowerCase();
      const existing = snapshot.items.find(
        (item) =>
          !item.isClosed &&
          item.title.trim().toLowerCase() === wanted &&
          (!repository || item.repository?.toLowerCase() === repository),
      );
      if (existing) {
        return { ...describeItem(snapshot, existing), message: 'Já existe uma tarefa aberta com este título; nada foi criado. Use board_update_task para mudá-la.' };
      }
      // Without a repository the task would be a loose draft on the board that no workflow ever picks: an agent
      // working on a project creates it in that project's repository unless it names another one.
      const ownRepository = !text(args.repository) && agent.projectId ? await projectRepository(agent.projectId) : null;
      const prepared = await prepareTaskByNames(agent.workspaceId, ownRepository ? { ...args, repository: ownRepository } : args).catch((error: unknown) =>
        ownRepository ? prepareTaskByNames(agent.workspaceId, args) : Promise.reject(error),
      );
      const { id } = await createTask(agent.workspaceId, prepared);
      const title = text(args.title, 250)!;
      const created = (await boardContext(agent.workspaceId)).snapshot.items.find((item) => item.id === id);
      const summary = created ? describeItem(snapshot, created) : { id, title, ref: null, url: null };
      await mergeResult(agentId, { createdTasks: [{ id, title, ref: summary.ref, url: summary.url }] });
      return summary;
    }

    case 'board_update_task': {
      if (!agent.tools.includes('board')) throw new HttpError(403, 'Este agente só pode consultar o quadro.');
      const item = findItem(args.id);
      const title = text(args.title, 250)?.trim();
      const body = text(args.body);
      if (title !== undefined || body !== undefined) {
        if (title === '') throw new HttpError(400, 'O título não pode ficar vazio.');
        await editItem(agent.workspaceId, item.id, { ...(title !== undefined && { title }), ...(body !== undefined && { body }) });
      }
      if (text(args.column)) await moveItem(agent.workspaceId, item.id, resolveColumn(snapshot.columns, text(args.column)!).id);
      const { resolved, errors } = resolveFields(snapshot.fields, (args.fields ?? {}) as Record<string, string>);
      if (errors.length > 0) throw new HttpError(422, errors.join(' '));
      for (const [fieldId, optionId] of Object.entries(resolved)) await setItemField(agent.workspaceId, item.id, fieldId, optionId);
      return describeItem(snapshot, findItem(args.id));
    }
  }
}
