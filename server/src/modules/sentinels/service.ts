import { prisma } from '../../db.js';
import type { Prisma, Sentinel } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import type { AgentModel } from '../agents/service.js';

export interface SentinelInput {
  name: string;
  isEnabled: boolean;
  fieldFilters: Record<string, string[]>;
  repositories: string[];
  columnId: string | null;
  onlyUnassigned: boolean;
  instructions: string;
  model: AgentModel;
  maxConcurrent: number;
}

const WORKING_STATUSES = ['PREPARING', 'RUNNING', 'WAITING_INPUT'] as const;

/** Drops empty filter lists so "any value" is stored as no filter. */
function cleanFilters(filters: Record<string, string[]>) {
  return Object.fromEntries(Object.entries(filters).filter(([, options]) => options.length > 0));
}

async function toResponse(sentinel: Sentinel) {
  const [working, total] = await Promise.all([
    prisma.agent.count({ where: { sentinelId: sentinel.id, status: { in: [...WORKING_STATUSES] } } }),
    prisma.agent.count({ where: { sentinelId: sentinel.id } }),
  ]);
  return {
    id: sentinel.id,
    workspaceId: sentinel.workspaceId,
    name: sentinel.name,
    isEnabled: sentinel.isEnabled,
    fieldFilters: sentinel.fieldFilters as Record<string, string[]>,
    repositories: sentinel.repositories,
    columnId: sentinel.columnId,
    onlyUnassigned: sentinel.onlyUnassigned,
    instructions: sentinel.instructions,
    model: sentinel.model,
    maxConcurrent: sentinel.maxConcurrent,
    lastCheckedAt: sentinel.lastCheckedAt,
    lastLaunchAt: sentinel.lastLaunchAt,
    statusMessage: sentinel.statusMessage,
    workingAgents: working,
    totalAgents: total,
    createdAt: sentinel.createdAt,
  };
}

export async function listSentinels(workspaceId: string) {
  const sentinels = await prisma.sentinel.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  return Promise.all(sentinels.map(toResponse));
}

export async function createSentinel(workspaceId: string, input: SentinelInput) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const sentinel = await prisma.sentinel.create({
    data: { workspaceId, ...input, fieldFilters: cleanFilters(input.fieldFilters) as Prisma.InputJsonValue },
  });
  return toResponse(sentinel);
}

export async function updateSentinel(id: string, input: Partial<SentinelInput>) {
  await findOrThrow(id);
  const sentinel = await prisma.sentinel.update({
    where: { id },
    data: {
      ...input,
      ...(input.fieldFilters && { fieldFilters: cleanFilters(input.fieldFilters) as Prisma.InputJsonValue }),
      // A changed rule gets a fresh status on the next round.
      statusMessage: input.isEnabled === false ? 'Desativada.' : null,
    },
  });
  return toResponse(sentinel);
}

/** Agents it launched keep running; they just lose the link to the sentinel. */
export async function deleteSentinel(id: string) {
  await findOrThrow(id);
  await prisma.sentinel.delete({ where: { id } });
}

export async function getSentinel(id: string) {
  return toResponse(await findOrThrow(id));
}

export async function findOrThrow(id: string) {
  const sentinel = await prisma.sentinel.findUnique({ where: { id } });
  if (!sentinel) throw notFound('Sentinela não encontrada.');
  return sentinel;
}
