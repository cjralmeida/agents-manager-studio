import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { deliverToOrbi } from './conversation.js';

export type ActivityKind = 'answer' | 'message' | 'task' | 'workflow' | 'pause' | 'resume' | 'capacity' | 'conflict' | 'flag';

/** Records what Órbi did by itself, or (flag) a decision it left for the user. */
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

/** Decisions Órbi left for the user that nobody dealt with yet. */
export async function listOpenFlags(ownerId: string) {
  const rows = await prisma.orbiActivity.findMany({ where: { ownerId, kind: 'flag', resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
  return withWorkspaceNames(rows);
}

export async function resolveFlag(ownerId: string, id: string) {
  const flag = await prisma.orbiActivity.findFirst({ where: { id, ownerId, kind: 'flag' } });
  if (!flag) throw notFound('Decisão não encontrada.');
  return prisma.orbiActivity.update({ where: { id }, data: { resolvedAt: new Date() } });
}

interface FlagDetails {
  details?: string | null;
  options?: string[];
  decidedOption?: string | null;
  decidedAt?: string;
}

/**
 * The user's answer to a decision Órbi left: one of its options (and/or a note), or "let's talk" with neither. It goes
 * to the Órbi conversation, which acts on it and marks the decision as resolved (studio_resolve_flag).
 */
export async function decideFlag(ownerId: string, id: string, input: { option?: string; note?: string }) {
  const flag = await prisma.orbiActivity.findFirst({ where: { id, ownerId, kind: 'flag', resolvedAt: null } });
  if (!flag) throw notFound('Decisão não encontrada ou já resolvida.');
  const details = (flag.details ?? {}) as FlagDetails;
  const option = input.option?.trim() || null;
  if (option && !(details.options ?? []).includes(option)) throw new HttpError(400, 'Essa opção não existe nesta decisão.');
  const note = input.note?.trim() || null;
  const context = [`"${flag.summary}"`, ...(details.details ? [`Detalhes: ${details.details}`] : []), ...(flag.link ? [`Link: ${flag.link}`] : []), `(id da decisão: ${flag.id})`];
  const message =
    option || note
      ? [
          '[Decisão do usuário]',
          ...context,
          '',
          ...(option ? [`Escolha: ${option}`] : []),
          ...(note ? [`Observação: ${note}`] : []),
          '',
          'Faça o que for preciso para cumprir a escolha, com as suas ferramentas, conte em uma frase o que fez e marque a decisão com studio_resolve_flag.',
        ]
      : [
          '[Vamos resolver juntos] O usuário abriu esta decisão para conversar:',
          ...context,
          '',
          'Explique em poucas linhas o que precisa ser decidido e pergunte com opções (AskUserQuestion). Depois que ele decidir, faça o que for preciso e marque com studio_resolve_flag.',
        ];
  const conversation = await deliverToOrbi(ownerId, message.join('\n'), flag.workspaceId ?? undefined);
  if (option || note) {
    await prisma.orbiActivity.update({ where: { id }, data: { details: { ...details, decidedOption: option ?? note, decidedAt: new Date().toISOString() } } });
  }
  return { conversationId: conversation.id };
}
