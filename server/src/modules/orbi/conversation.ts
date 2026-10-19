import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { addEvent, sendMessage } from '../agents/service.js';
import type { AttachmentInput } from '../assistant/attachments.js';
import { continueConversation, startConversation } from '../assistant/service.js';
import { deleteUserSetting, getUserSetting, setUserSetting } from '../users/settings.js';
import { ownerWorkspaces } from './ops.js';

/**
 * The user's one Órbi conversation: what they write, what the routines do and the decisions they take all happen in
 * it, one message at a time. A new one starts only when there is none yet, the last one ended or the user restarts it
 * (the old ones stay as history). Claude compacts the context by itself as it grows.
 */

const CONVERSATION_KEY = 'orbiConversation';
const MODEL_KEY = 'orbiModel';
export type OrbiModel = 'sonnet' | 'opus';

export async function orbiModel(ownerId: string): Promise<OrbiModel> {
  return (await getUserSetting<OrbiModel>(ownerId, MODEL_KEY)) === 'opus' ? 'opus' : 'sonnet';
}

/** The current conversation, or null when the next message starts a new one. */
export async function currentConversation(ownerId: string) {
  const id = await getUserSetting<string>(ownerId, CONVERSATION_KEY);
  if (!id) return null;
  const agent = await prisma.agent.findUnique({ where: { id }, include: { workspace: { select: { ownerId: true } } } });
  const usable = agent && agent.kind === 'ASSISTANT' && agent.workspace.ownerId === ownerId && !['CANCELLED', 'FAILED'].includes(agent.status) && !agent.workdirRemovedAt;
  return usable ? agent : null;
}

export async function conversationInfo(ownerId: string) {
  const [conversation, model] = await Promise.all([currentConversation(ownerId), orbiModel(ownerId)]);
  return { conversationId: conversation?.id ?? null, model };
}

async function startIn(ownerId: string, workspaceId: string | undefined, message: string, context?: string, attachments?: AttachmentInput[]) {
  const workspaces = await ownerWorkspaces(ownerId);
  const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? (await busiestWorkspace(workspaces));
  if (!workspace) throw new HttpError(422, 'Nenhum workspace disponível para o Órbi.');
  // Dated, so the conversations in the history tell apart.
  const since = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const agent = await startConversation(workspace.id, message, context, { title: `Conversa desde ${since}`, model: await orbiModel(ownerId), attachments });
  await setUserSetting(ownerId, CONVERSATION_KEY, agent.id);
  return agent;
}

/** The workspace with the most workflows on (where the work is), to start focused on it. */
export async function busiestWorkspace<T extends { id: string }>(workspaces: T[]): Promise<T | undefined> {
  const counts = await prisma.workflow.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: workspaces.map((entry) => entry.id) }, isEnabled: true }, _count: true });
  const on = (id: string) => counts.find((entry) => entry.workspaceId === id)?._count ?? 0;
  return [...workspaces].sort((a, b) => on(b.id) - on(a.id))[0];
}

/** A message from the user (the Órbi page or the side panel). */
export async function sendToOrbi(ownerId: string, input: { message: string; context?: string; attachments?: AttachmentInput[]; workspaceId?: string }) {
  const current = await currentConversation(ownerId);
  if (current) return continueConversation(current.id, input.message, input.context, input.attachments);
  return startIn(ownerId, input.workspaceId, input.message, input.context, input.attachments);
}

export type OrbiState = 'none' | 'idle' | 'busy' | 'waiting';

export async function orbiState(ownerId: string): Promise<OrbiState> {
  const current = await currentConversation(ownerId);
  if (!current) return 'none';
  if (current.status === 'WAITING_INPUT') return 'waiting';
  return current.status === 'RUNNING' || current.status === 'PREPARING' ? 'busy' : 'idle';
}

/**
 * A message from the Studio itself (a routine, a decision the user took). While Órbi asks the user something, a plain
 * message would become the answer: then it waits in the inbox and is read after the user answers.
 */
export async function deliverToOrbi(ownerId: string, message: string, workspaceId?: string) {
  const current = await currentConversation(ownerId);
  if (!current) return startIn(ownerId, workspaceId, message);
  if (current.status === 'WAITING_INPUT') {
    await prisma.agentInbox.create({ data: { agentId: current.id, kind: 'MESSAGE', payload: { text: message } } });
    await addEvent(current.id, 'user_message', { text: message });
    return current;
  }
  return sendMessage(current.id, message);
}

/** The model for the conversation; the current one switches on its next start. */
export async function setOrbiModel(ownerId: string, model: OrbiModel) {
  await setUserSetting(ownerId, MODEL_KEY, model);
  const current = await currentConversation(ownerId);
  if (current) await prisma.agent.update({ where: { id: current.id }, data: { model } });
  return conversationInfo(ownerId);
}

/** The next message starts a fresh conversation (a clean context); the old one stays in the history. */
export async function restartConversation(ownerId: string) {
  await deleteUserSetting(ownerId, CONVERSATION_KEY);
  return conversationInfo(ownerId);
}
