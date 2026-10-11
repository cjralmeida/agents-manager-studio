import { z } from 'zod';
import { prisma } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';

/**
 * A process groups the workflows that together reach one goal (e.g. "Criação de jogo": idea → tasks, art, code,
 * decisions). It only organizes and shows them as one canvas; each workflow keeps its own trigger and runs as before.
 */
export const processSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000).default(''),
    workflowIds: z.array(z.uuid()).max(50).default([]),
  })
  .strict();
export type ProcessInput = z.infer<typeof processSchema>;

function toResponse(process: { id: string; workspaceId: string; name: string; description: string; createdAt: Date; workflows: { id: string }[] }) {
  const { workflows, ...rest } = process;
  return { ...rest, workflowIds: workflows.map((workflow) => workflow.id) };
}

const include = { workflows: { select: { id: true }, orderBy: { createdAt: 'asc' } } } as const;

async function ensureWorkflows(workspaceId: string, ids: string[]) {
  if ((await prisma.workflow.count({ where: { id: { in: ids }, workspaceId } })) !== new Set(ids).size) {
    throw new HttpError(422, 'Workflow não encontrado neste workspace.');
  }
}

function duplicateName(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function listProcesses(workspaceId: string) {
  const processes = await prisma.workflowProcess.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, include });
  return processes.map(toResponse);
}

export async function createProcess(workspaceId: string, input: ProcessInput) {
  if (!(await prisma.workspace.count({ where: { id: workspaceId } }))) throw notFound('Workspace não encontrado.');
  await ensureWorkflows(workspaceId, input.workflowIds);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const process = await tx.workflowProcess.create({ data: { workspaceId, name: input.name, description: input.description } });
      await tx.workflow.updateMany({ where: { id: { in: input.workflowIds }, workspaceId }, data: { processId: process.id } });
      return tx.workflowProcess.findUniqueOrThrow({ where: { id: process.id }, include });
    });
    return toResponse(created);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, 'Já existe um processo com esse nome neste workspace.');
    throw error;
  }
}

/** A workflow belongs to one process: listing it here takes it out of the other. */
export async function updateProcess(id: string, input: Partial<ProcessInput>) {
  const current = await prisma.workflowProcess.findUnique({ where: { id } });
  if (!current) throw notFound('Processo não encontrado.');
  if (input.workflowIds) await ensureWorkflows(current.workspaceId, input.workflowIds);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.workflowProcess.update({ where: { id }, data: { name: input.name, description: input.description } });
      if (input.workflowIds) {
        await tx.workflow.updateMany({ where: { processId: id, id: { notIn: input.workflowIds } }, data: { processId: null } });
        await tx.workflow.updateMany({ where: { id: { in: input.workflowIds }, workspaceId: current.workspaceId }, data: { processId: id } });
      }
      return tx.workflowProcess.findUniqueOrThrow({ where: { id }, include });
    });
    return toResponse(updated);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, 'Já existe um processo com esse nome neste workspace.');
    throw error;
  }
}

/** The workflows stay, outside any process. */
export async function deleteProcess(id: string) {
  const deleted = await prisma.workflowProcess.deleteMany({ where: { id } });
  if (deleted.count === 0) throw notFound('Processo não encontrado.');
}
