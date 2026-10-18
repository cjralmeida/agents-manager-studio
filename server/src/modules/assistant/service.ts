import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { launchAgent, sendMessage } from '../agents/service.js';
import { workdirPath } from '../agents/workdir.js';
import { type AttachmentInput, describeAttachments, prepareAttachments, type PreparedAttachments } from './attachments.js';

/** Where the user is when writing, so "este workflow" or "aqui" make sense to Órbi; the attachments come before it. */
function withContext(message: string, context?: string, files?: PreparedAttachments | null) {
  const text = [message.trim(), files ? describeAttachments(files.attachments) : ''].filter(Boolean).join('\n\n');
  return context?.trim() ? `${text}\n\n[Contexto: ${context.trim()}]` : text;
}

function requireContent(message: string, files: PreparedAttachments | null) {
  if (!message.trim() && !files) throw new HttpError(422, 'Escreva uma mensagem ou anexe um arquivo.');
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

export async function startConversation(
  workspaceId: string,
  message: string,
  context?: string,
  options: { model?: 'sonnet' | 'opus'; title?: string; attachments?: AttachmentInput[] } = {},
) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const files = prepareAttachments(options.attachments);
  requireContent(message, files);
  const firstLine = (message.trim().split('\n')[0] ?? '') || (files?.attachments.map((attachment) => attachment.name).join(', ') ?? '');
  return launchAgent({
    assistantWorkspaceId: workspaceId,
    prompt: withContext(message, context, files),
    title: `Órbi: ${options.title ?? firstLine.slice(0, 100)}`,
    // Written in the conversation's empty folder before its container starts.
    ...(files && { attachments: files.attachments, writeFiles: files.write }),
    model: options.model ?? 'sonnet',
    // The panel is for conversation; Órbi never needs the high-usage confirmation dialog.
    confirmHighUsage: true,
  });
}

export async function continueConversation(agentId: string, message: string, context?: string, attachments?: AttachmentInput[]) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.kind !== 'ASSISTANT') throw notFound('Conversa não encontrada.');
  if (agent.status === 'CANCELLED') throw new HttpError(409, 'Esta conversa foi encerrada; comece uma nova.');
  if (agent.workdirRemovedAt) throw new HttpError(409, 'A pasta desta conversa foi removida; comece uma nova.');
  const files = prepareAttachments(attachments);
  requireContent(message, files);
  // Saved in the conversation's folder (mounted in its container), before Órbi reads the message.
  await files?.write(workdirPath(agent.workdir));
  return sendMessage(agentId, withContext(message, context, files), files?.attachments);
}

/** Renames an Órbi conversation of the user. */
export async function renameConversation(ownerId: string, agentId: string, title: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { workspace: { select: { ownerId: true } } } });
  if (!agent || agent.kind !== 'ASSISTANT' || agent.workspace.ownerId !== ownerId) throw notFound('Conversa não encontrada.');
  await prisma.agent.update({ where: { id: agentId }, data: { title: `Órbi: ${title.trim()}` } });
  return { id: agentId, title: title.trim() };
}
