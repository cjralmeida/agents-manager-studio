import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import type { MessageAttachment } from '../agents/service.js';

/**
 * Images and audios the user sends to Órbi. They are saved in the conversation's own work folder (anexos/, seen as
 * /workspace/anexos in its container), so deleting the conversation deletes them with it.
 */

export const ATTACHMENTS_DIR = 'anexos';
const AGENT_UID = '1000:1000';
const MAX_FILES = 8;
const MAX_FILE_BYTES = 10_000_000;
const MAX_TOTAL_BYTES = 30_000_000;
/** JSON body limit of the routes taking attachments (base64 grows the files by a third). */
export const ATTACHMENTS_BODY_LIMIT = Math.ceil((MAX_TOTAL_BYTES * 4) / 3) + 1_000_000;

const TYPES: Record<string, { kind: MessageAttachment['kind']; ext: string }> = {
  'image/png': { kind: 'image', ext: '.png' },
  'image/jpeg': { kind: 'image', ext: '.jpg' },
  'image/gif': { kind: 'image', ext: '.gif' },
  'image/webp': { kind: 'image', ext: '.webp' },
  'audio/webm': { kind: 'audio', ext: '.webm' },
  'audio/ogg': { kind: 'audio', ext: '.ogg' },
  'audio/mpeg': { kind: 'audio', ext: '.mp3' },
  'audio/wav': { kind: 'audio', ext: '.wav' },
  'audio/x-wav': { kind: 'audio', ext: '.wav' },
  'audio/mp4': { kind: 'audio', ext: '.m4a' },
  'audio/x-m4a': { kind: 'audio', ext: '.m4a' },
};

export const attachmentsSchema = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(200),
        /** MIME type; codec parameters (e.g. "audio/webm;codecs=opus") are ignored. */
        type: z.string().max(100),
        /** File content in base64. */
        data: z.string().min(1),
        transcript: z.string().trim().max(20_000).optional(),
      })
      .strict(),
  )
  .max(MAX_FILES);

export type AttachmentInput = z.infer<typeof attachmentsSchema>[number];

export interface PreparedAttachments {
  attachments: MessageAttachment[];
  /** Writes the files into a conversation's work folder (as the server sees it). */
  write: (dir: string) => Promise<void>;
}

const safeName = (name: string) =>
  path
    .parse(name)
    .name.normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'anexo';

/** Checks the files and names them; nothing is written yet. */
export function prepareAttachments(inputs: AttachmentInput[] = []): PreparedAttachments | null {
  if (inputs.length === 0) return null;
  let total = 0;
  const files = inputs.map((input) => {
    const type = TYPES[input.type.split(';')[0]!.trim().toLowerCase()];
    if (!type) throw new HttpError(422, `"${input.name}": envie imagens (PNG, JPG, GIF, WebP) ou áudios (WebM, OGG, MP3, WAV, M4A).`);
    const content = Buffer.from(input.data, 'base64');
    if (content.length === 0) throw new HttpError(422, `"${input.name}" está vazio.`);
    if (content.length > MAX_FILE_BYTES) throw new HttpError(413, `"${input.name}" passa de ${MAX_FILE_BYTES / 1_000_000} MB.`);
    total += content.length;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const file = `${stamp}-${randomBytes(3).toString('hex')}-${safeName(input.name)}${type.ext}`;
    const attachment: MessageAttachment = { path: `${ATTACHMENTS_DIR}/${file}`, kind: type.kind, name: input.name };
    if (type.kind === 'audio' && input.transcript) attachment.transcript = input.transcript;
    return { attachment, content };
  });
  if (total > MAX_TOTAL_BYTES) throw new HttpError(413, `Os anexos passam de ${MAX_TOTAL_BYTES / 1_000_000} MB juntos.`);

  return {
    attachments: files.map((file) => file.attachment),
    write: async (dir) => {
      const folder = path.posix.join(dir, ATTACHMENTS_DIR);
      await mkdir(folder, { recursive: true });
      for (const file of files) await writeFile(path.posix.join(dir, file.attachment.path), file.content);
      // The agent runs as "node": the folder is its own, like the rest of /workspace.
      await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, folder], () => resolve()));
    },
  };
}

/** What Órbi reads about the attachments, after the user's text. */
export function describeAttachments(attachments: MessageAttachment[]) {
  const lines = attachments.map((attachment) => {
    const where = `/workspace/${attachment.path}`;
    if (attachment.kind === 'image') return `- Imagem "${attachment.name}": ${where} (abra com a ferramenta Read para ver).`;
    return attachment.transcript
      ? `- Áudio "${attachment.name}": ${where}. Transcrição feita pelo navegador: "${attachment.transcript}"`
      : `- Áudio "${attachment.name}": ${where} (sem transcrição).`;
  });
  return ['[Anexos do usuário]', ...lines].join('\n');
}
