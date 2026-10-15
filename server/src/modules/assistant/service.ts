import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { launchAgent, sendMessage } from '../agents/service.js';

/** Where the user is when writing, so "este workflow" or "aqui" make sense to Órbi. */
function withContext(message: string, context?: string) {
  return context?.trim() ? `${message.trim()}\n\n[Contexto: ${context.trim()}]` : message.trim();
}

/**
 * Órbi conversations of the user, over all their workspaces (a conversation starts focused on one workspace and can
 * move to another with studio_focus).
 */
export async function listConversations(ownerId: string) {
  const conversations = await prisma.agent.findMany({
    // The Gestor de Capacidade's analyses are Órbi conversations too, but they live in the Workflows tab.
    where: { kind: 'ASSISTANT', workspace: { ownerId }, capacityReviews: { none: {} }, NOT: { OR: [{ title: { startsWith: 'Órbi: Gestor de Capacidade' } }, { title: { startsWith: 'Gestor de Capacidade' } }] } },
    orderBy: { lastActivityAt: 'desc' },
    take: 40,
    select: { id: true, title: true, status: true, lastActivityAt: true, createdAt: true, workspaceId: true, workspace: { select: { name: true } } },
  });
  return conversations.map(({ workspace, ...conversation }) => ({ ...conversation, title: conversation.title.replace(/^Órbi: /, ''), workspaceName: workspace.name }));
}

export async function startConversation(workspaceId: string, message: string, context?: string, options: { model?: 'sonnet' | 'opus'; title?: string } = {}) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  return launchAgent({
    assistantWorkspaceId: workspaceId,
    prompt: withContext(message, context),
    title: `Órbi: ${options.title ?? (message.trim().split('\n')[0] ?? '').slice(0, 100)}`,
    model: options.model ?? 'sonnet',
    // The panel is for conversation; Órbi never needs the high-usage confirmation dialog.
    confirmHighUsage: true,
  });
}

export async function continueConversation(agentId: string, message: string, context?: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.kind !== 'ASSISTANT') throw notFound('Conversa não encontrada.');
  if (agent.status === 'CANCELLED') throw new HttpError(409, 'Esta conversa foi encerrada; comece uma nova.');
  return sendMessage(agentId, withContext(message, context));
}

/** Renames an Órbi conversation of the user. */
export async function renameConversation(ownerId: string, agentId: string, title: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { workspace: { select: { ownerId: true } } } });
  if (!agent || agent.kind !== 'ASSISTANT' || agent.workspace.ownerId !== ownerId) throw notFound('Conversa não encontrada.');
  await prisma.agent.update({ where: { id: agentId }, data: { title: `Órbi: ${title.trim()}` } });
  return { id: agentId, title: title.trim() };
}
