import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { type AttachmentInput, describeAttachments, prepareAttachments } from '../assistant/attachments.js';
import type { MessageAttachment } from './service.js';
import { workdirPath } from './workdir.js';

/**
 * Images and audios the user sends to a task agent (with a message or an answer): written into its work folder
 * (anexos/, /workspace/anexos in the container) and described after the text, like Órbi's attachments.
 */
export async function saveUserAttachments(agentId: string, inputs: AttachmentInput[] | undefined): Promise<{ attachments: MessageAttachment[]; note: string }> {
  const prepared = prepareAttachments(inputs ?? []);
  if (!prepared) return { attachments: [], note: '' };
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { workdir: true, workdirRemovedAt: true } });
  if (!agent) throw new HttpError(404, 'Agente não encontrado.');
  if (agent.workdirRemovedAt) throw new HttpError(409, 'A cópia deste agente já foi removida: não há onde guardar os anexos.');
  await prepared.write(workdirPath(agent.workdir));
  return { attachments: prepared.attachments, note: `\n\n${describeAttachments(prepared.attachments)}` };
}
