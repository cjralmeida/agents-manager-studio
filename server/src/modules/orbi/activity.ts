import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import { startConversation } from '../assistant/service.js';

export type ActivityKind = 'answer' | 'message' | 'task' | 'workflow' | 'pause' | 'resume' | 'capacity' | 'conflict' | 'flag';

/** Records what Órbi did by itself, or (flag) something it left for the user. */
export async function logActivity(input: {
  ownerId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  kind: ActivityKind;
  summary: string;
  details?: unknown;
  link?: string | null;
}) {
  return prisma.orbiActivity.create({
    data: {
      ownerId: input.ownerId,
      workspaceId: input.workspaceId ?? null,
      conversationId: input.conversationId ?? null,
      kind: input.kind,
      summary: input.summary.slice(0, 500),
      details: (input.details ?? undefined) as Prisma.InputJsonValue | undefined,
      link: input.link ?? null,
    },
  });
}

async function withWorkspaceNames<T extends { workspaceId: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])))];
  const workspaces = await prisma.workspace.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  return rows.map((row) => ({ ...row, workspaceName: row.workspaceId ? (names.get(row.workspaceId) ?? null) : null }));
}

export async function listActivity(ownerId: string, limit = 50) {
  const rows = await prisma.orbiActivity.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 200) });
  return withWorkspaceNames(rows);
}

/** Flags Órbi left for the user and nobody dealt with yet. */
export async function listOpenFlags(ownerId: string) {
  const rows = await prisma.orbiActivity.findMany({ where: { ownerId, kind: 'flag', resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
  return withWorkspaceNames(rows);
}

export async function resolveFlag(ownerId: string, id: string) {
  const flag = await prisma.orbiActivity.findFirst({ where: { id, ownerId, kind: 'flag' } });
  if (!flag) throw notFound('Aviso não encontrado.');
  return prisma.orbiActivity.update({ where: { id }, data: { resolvedAt: new Date() } });
}

/**
 * A conversation with Órbi to sort out a flag with the user: started with the flag, its details and link; the same
 * conversation is reopened while it is still usable.
 */
export async function discussFlag(ownerId: string, id: string) {
  const flag = await prisma.orbiActivity.findFirst({ where: { id, ownerId, kind: 'flag' } });
  if (!flag) throw notFound('Aviso não encontrado.');
  const details = (flag.details ?? {}) as { details?: string | null; discussionId?: string };
  if (details.discussionId) {
    const existing = await prisma.agent.findUnique({ where: { id: details.discussionId }, select: { id: true, status: true } });
    if (existing && existing.status !== 'CANCELLED') return { conversationId: existing.id };
  }
  const workspaceId = flag.workspaceId ?? (await prisma.workspace.findFirstOrThrow({ where: { ownerId, isIgnored: false }, select: { id: true } })).id;
  const message = [
    'Quero resolver com você este aviso que um piloto deixou para mim:',
    `"${flag.summary}"`,
    ...(details.details ? ['', `Detalhes: ${details.details}`] : []),
    ...(flag.link ? ['', `Link: ${flag.link}`] : []),
    '',
    'Veja a situação (a tarefa, as execuções e o que os agentes já fizeram), me explique em poucas linhas o que precisa ser decidido e me pergunte com opções (AskUserQuestion). Depois de eu decidir, faça o que for preciso.',
  ].join('\n');
  const conversation = await startConversation(workspaceId, message, undefined, { title: flag.summary.slice(0, 80) });
  await prisma.orbiActivity.update({ where: { id }, data: { details: { ...details, discussionId: conversation.id } } });
  return { conversationId: conversation.id };
}
