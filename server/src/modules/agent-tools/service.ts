import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { boardContext, createTask, moveItem, setItemField } from '../boards/service.js';
import type { BoardItem, BoardSnapshot } from '../boards/types.js';
import { findByName, resolveColumn, resolveFields } from './resolve.js';

/** Tools the runner can call for an agent; board tools need the "board" group on the agent. */
export const AGENT_TOOL_NAMES = [
  'report_result',
  'board_list_tasks',
  'board_get_task',
  'board_create_task',
  'board_update_task',
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

/** Runs a tool for an agent. Problems the agent can fix are thrown as messages it will read. */
export async function runAgentTool(agentId: string, name: AgentToolName, args: Args) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  if (name === 'report_result') {
    const status = args.status === 'failure' ? 'failure' : 'success';
    const summary = text(args.summary, 20_000) ?? '';
    await mergeResult(agentId, { status, summary, details: text(args.details) });
    return { ok: true, message: 'Resultado registrado. Encerre com um resumo curto.' };
  }

  if (!agent.tools.includes('board')) throw new HttpError(403, 'Este agente não tem acesso ao quadro de tarefas.');
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
        repositories: repos.map((repo) => repo.path),
        tasks: items.map((item) => describeItem(snapshot, item)),
      };
    }

    case 'board_get_task':
      return describeItem(snapshot, findItem(args.id), true);

    case 'board_create_task': {
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

      const { id } = await createTask(agent.workspaceId, {
        title,
        body: text(args.body) ?? '',
        repository: repository?.path ?? null,
        columnId: column?.id ?? null,
        fields: resolved,
      });
      const created = (await boardContext(agent.workspaceId)).snapshot.items.find((item) => item.id === id);
      const summary = created ? describeItem(snapshot, created) : { id, title, ref: null, url: null };
      await mergeResult(agentId, { createdTasks: [{ id, title, ref: summary.ref, url: summary.url }] });
      return summary;
    }

    case 'board_update_task': {
      const item = findItem(args.id);
      if (text(args.column)) await moveItem(agent.workspaceId, item.id, resolveColumn(snapshot.columns, text(args.column)!).id);
      const { resolved, errors } = resolveFields(snapshot.fields, (args.fields ?? {}) as Record<string, string>);
      if (errors.length > 0) throw new HttpError(422, errors.join(' '));
      for (const [fieldId, optionId] of Object.entries(resolved)) await setItemField(agent.workspaceId, item.id, fieldId, optionId);
      return describeItem(snapshot, findItem(args.id));
    }
  }
}
