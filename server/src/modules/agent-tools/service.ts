import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { boardContext, createTask, editItem, moveItem, setItemField } from '../boards/service.js';
import type { BoardItem, BoardSnapshot } from '../boards/types.js';
import { findByName, resolveColumn, resolveFields } from './resolve.js';
import { RENDER_READ_TOOLS, RENDER_TOOL_NAMES, type RenderToolName, runRenderTool } from '../render/agent-tools.js';
import { runStudioTool } from './studio.js';

/** Tools the runner can call for an agent; board tools need the "board" group on the agent. */
export const AGENT_TOOL_NAMES = [
  'report_result',
  'board_list_tasks',
  'board_get_task',
  'board_create_task',
  'board_update_task',
  'studio_context',
  'studio_list_runs',
  'studio_list_executions',
  'studio_get_execution',
  'studio_usage',
  'studio_propose',
  'studio_board_options',
  'studio_render_services',
  ...RENDER_TOOL_NAMES,
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** What a workflow reads from an agent: its reported outcome and the tasks it created. */
export interface AgentResult {
  status?: 'success' | 'failure';
  summary?: string;
  details?: string;
  createdTasks?: { id: string; title: string; ref: string | null; url: string | null }[];
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
  return { title, body: text(args.body) ?? '', repository: repository?.path ?? null, columnId: column?.id ?? null, fields: resolved };
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

  if (name.startsWith('render_')) {
    const allowed = agent.tools.includes('render') || (agent.tools.includes('render_read') && RENDER_READ_TOOLS.includes(name));
    if (!allowed) throw new HttpError(403, 'Este agente não tem acesso a esta ferramenta do Render.');
    return runRenderTool(agent, name as RenderToolName, args);
  }

  if (name.startsWith('studio_')) {
    if (!agent.tools.includes('studio')) throw new HttpError(403, 'Ferramenta exclusiva do Órbi.');
    return runStudioTool(agent.id, agent.workspaceId, name, args);
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
      const { id } = await createTask(agent.workspaceId, await prepareTaskByNames(agent.workspaceId, args));
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
