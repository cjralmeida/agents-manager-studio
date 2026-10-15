import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import { addEvent, sendMessage } from '../agents/service.js';
import { startConversation } from '../assistant/service.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';

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

const PENDING_CONVERSATION_KEY = 'orbiPendingConversation';

/**
 * Flags are sorted out with the user in one conversation, "Pendências": each flag the user brings goes to it as a
 * new message (a new one starts when it was deleted or cancelled). The flag remembers it, so it can be reopened.
 */
export async function discussFlag(ownerId: string, id: string) {
  const flag = await prisma.orbiActivity.findFirst({ where: { id, ownerId, kind: 'flag' } });
  if (!flag) throw notFound('Aviso não encontrado.');
  const details = (flag.details ?? {}) as { details?: string | null; discussionId?: string };
  const conversationId = await getUserSetting<string>(ownerId, PENDING_CONVERSATION_KEY);
  const current = conversationId ? await prisma.agent.findUnique({ where: { id: conversationId }, select: { id: true, status: true } }) : null;
  const usable = current && current.status !== 'CANCELLED';
  // Already brought to the current conversation: just open it.
  if (usable && details.discussionId === current.id) return { conversationId: current.id };

  const message = [
    'Nova pendência para resolvermos juntos — um aviso que um piloto deixou para mim:',
    `"${flag.summary}"`,
    ...(details.details ? ['', `Detalhes: ${details.details}`] : []),
    ...(flag.link ? ['', `Link: ${flag.link}`] : []),
    '',
    'Veja a situação (a tarefa, as execuções e o que os agentes já fizeram), me explique em poucas linhas o que precisa ser decidido e me pergunte com opções (AskUserQuestion). Depois de eu decidir, faça o que for preciso e diga quando esta pendência estiver resolvida.',
  ].join('\n');
  let target: string;
  if (usable) {
    if (current.status === 'WAITING_INPUT') {
      // A message now would answer the question Órbi is asking about the previous pendência: it waits in the inbox
      // and comes after the user answers.
      await prisma.agentInbox.create({ data: { agentId: current.id, kind: 'MESSAGE', payload: { text: message } } });
      await addEvent(current.id, 'user_message', { text: message });
    } else {
      await sendMessage(current.id, message);
    }
    target = current.id;
  } else {
    const workspaceId = flag.workspaceId ?? (await prisma.workspace.findFirstOrThrow({ where: { ownerId, isIgnored: false }, select: { id: true } })).id;
    const conversation = await startConversation(workspaceId, message, undefined, { title: 'Pendências' });
    await setUserSetting(ownerId, PENDING_CONVERSATION_KEY, conversation.id);
    target = conversation.id;
  }
  await prisma.orbiActivity.update({ where: { id }, data: { details: { ...details, discussionId: target } } });
  return { conversationId: target };
}
