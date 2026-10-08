import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { launchAgent, sendMessage } from '../agents/service.js';

/** Where the user is when writing, so "este workflow" or "aqui" make sense to Órbi. */
function withContext(message: string, context?: string) {
  return context?.trim() ? `${message.trim()}\n\n[Contexto: ${context.trim()}]` : message.trim();
}

export async function listConversations(workspaceId: string) {
  const conversations = await prisma.agent.findMany({
    where: { workspaceId, kind: 'ASSISTANT' },
    orderBy: { lastActivityAt: 'desc' },
    take: 20,
    select: { id: true, title: true, status: true, lastActivityAt: true, createdAt: true },
  });
  return conversations.map((conversation) => ({ ...conversation, title: conversation.title.replace(/^Órbi: /, '') }));
}

export async function startConversation(workspaceId: string, message: string, context?: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  return launchAgent({
    assistantWorkspaceId: workspaceId,
    prompt: withContext(message, context),
    title: `Órbi: ${(message.trim().split('\n')[0] ?? '').slice(0, 100)}`,
    model: 'sonnet',
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
