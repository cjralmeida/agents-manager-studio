import { prisma } from '../../db.js';
import type { LocalTask, Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import type { BoardModel } from './model.js';
import { GITHUB_COLORS } from './template.js';
import type { BoardAdapter, BoardItem, BoardSnapshot } from './types.js';

/**
 * A board that lives only in the Studio: its columns and fields are the board model itself (ids included), and the
 * tasks are rows of local_tasks. The "repository" of a task is the name of its workspace project.
 */

const hex = (option: { color: keyof typeof GITHUB_COLORS }) => GITHUB_COLORS[option.color];

function toItem(task: LocalTask & { project: { name: string } | null }, model: BoardModel): BoardItem {
  const todo = model.columns.find((column) => column.role === 'todo')!;
  const done = model.columns.find((column) => column.role === 'done')!;
  // A column or option removed from the model without a destination falls back to "todo" / no value.
  const columnId = model.columns.some((column) => column.id === task.columnId) ? task.columnId : todo.id;
  const stored = (task.fields ?? {}) as Record<string, string>;
  const fields: Record<string, string> = {};
  for (const field of model.fields) {
    const optionId = stored[field.id];
    if (optionId && field.options.some((option) => option.id === optionId)) fields[field.id] = optionId;
  }
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    url: null,
    number: task.number,
    repository: task.project?.name ?? null,
    isDraft: task.projectId === null,
    isClosed: columnId === done.id,
    columnId,
    fields,
    assignees: task.assignees,
    pullRequests: [],
    updatedAt: task.updatedAt.toISOString(),
  };
}

const withProject = { project: { select: { name: true } } } as const;

export function createLocalAdapter(workspaceId: string, model: BoardModel): BoardAdapter {
  async function findTask(id: string) {
    const task = await prisma.localTask.findFirst({ where: { id, workspaceId } });
    if (!task) throw notFound('Tarefa não encontrada no quadro.');
    return task;
  }

  return {
    async load(): Promise<BoardSnapshot> {
      const tasks = await prisma.localTask.findMany({ where: { workspaceId }, include: withProject, orderBy: { number: 'desc' } });
      return {
        title: 'Quadro do Studio',
        url: `/workspaces/${workspaceId}?tab=board`,
        readme: null,
        columns: model.columns.map((column) => ({ id: column.id, name: column.name, color: hex(column), description: column.description || null })),
        statusFieldId: null,
        fields: model.fields.map((field) => ({
          id: field.id,
          name: field.name,
          options: field.options.map((option) => ({ id: option.id, name: option.name, color: hex(option), description: option.description || null })),
        })),
        items: tasks.map((task) => toItem(task, model)),
        supportsDrafts: true,
      };
    },

    async moveItem(_board, _snapshot, itemId, columnId) {
      await findTask(itemId);
      await prisma.localTask.update({ where: { id: itemId }, data: { columnId } });
    },

    async setItemField(_board, _snapshot, itemId, fieldId, optionId) {
      const task = await findTask(itemId);
      const { [fieldId]: _previous, ...rest } = (task.fields ?? {}) as Record<string, string>;
      const fields = optionId ? { ...rest, [fieldId]: optionId } : rest;
      await prisma.localTask.update({ where: { id: itemId }, data: { fields: fields as Prisma.InputJsonValue } });
    },

    async createTask(_board, _snapshot, task) {
      const project = task.repository
        ? await prisma.project.findFirst({ where: { workspaceId, name: { equals: task.repository, mode: 'insensitive' }, missingAt: null } })
        : null;
      if (task.repository && !project) throw new HttpError(422, `Projeto "${task.repository}" não encontrado neste workspace.`);
      const todo = model.columns.find((column) => column.role === 'todo')!;

      // Two tasks created at once may take the same number: the unique index refuses one and it tries again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const last = await prisma.localTask.findFirst({ where: { workspaceId }, orderBy: { number: 'desc' }, select: { number: true } });
        try {
          const created = await prisma.localTask.create({
            data: {
              workspaceId,
              number: (last?.number ?? 0) + 1,
              title: task.title,
              body: task.body,
              columnId: task.columnId ?? todo.id,
              fields: task.fields as Prisma.InputJsonValue,
              projectId: project?.id ?? null,
            },
            include: withProject,
          });
          return toItem(created, model);
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002' || attempt === 2) throw error;
        }
      }
      throw new HttpError(500, 'Não foi possível numerar a tarefa.');
    },

    async assignSelf() {
      // Agents are tracked by the Studio itself; there is no provider user to assign.
    },

    async applyStructure() {
      // The structure is the model; tasks are remapped by applyModelToLocalTasks.
    },
  };
}

/**
 * After a model change: cards of removed columns go to the chosen column, and values of removed fields/options
 * are dropped.
 */
export async function applyModelToLocalTasks(workspaceId: string, model: BoardModel, columnMoves: Record<string, string>) {
  for (const [from, to] of Object.entries(columnMoves)) {
    await prisma.localTask.updateMany({ where: { workspaceId, columnId: from }, data: { columnId: to } });
  }
  const tasks = await prisma.localTask.findMany({ where: { workspaceId } });
  for (const task of tasks) {
    const stored = (task.fields ?? {}) as Record<string, string>;
    const kept = Object.fromEntries(
      Object.entries(stored).filter(([fieldId, optionId]) => model.fields.some((field) => field.id === fieldId && field.options.some((option) => option.id === optionId))),
    );
    if (Object.keys(kept).length !== Object.keys(stored).length) {
      await prisma.localTask.update({ where: { id: task.id }, data: { fields: kept as Prisma.InputJsonValue } });
    }
  }
}
