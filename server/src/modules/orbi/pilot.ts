import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { sendMessage } from '../agents/service.js';
import { startConversation } from '../assistant/service.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { ownerWorkspaces, pendingItems } from './ops.js';

/**
 * Pilot mode: while it is on, Órbi wakes by itself when something needs the user — an agent question, a failed run,
 * a capacity suggestion — and deals with it with its tools, leaving the activity log as the report. Events go, once
 * each, to one pilot conversation per day.
 */

const KEY = 'orbiPilot';
const TICK_MS = 60_000;
const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface PilotSettings {
  enabled: boolean;
  /** All the user's workspaces, or only workspaceIds. */
  allWorkspaces: boolean;
  workspaceIds: string[];
  model: 'sonnet' | 'opus';
  /** The user's own rules for the pilot (e.g. "mudança de escopo grande espera por mim"). */
  instructions: string;
  conversationId: string | null;
  lastEventAt: string | null;
}

const DEFAULTS: PilotSettings = { enabled: false, allWorkspaces: true, workspaceIds: [], model: 'sonnet', instructions: '', conversationId: null, lastEventAt: null };

export async function getPilot(userId: string): Promise<PilotSettings> {
  return { ...DEFAULTS, ...((await getUserSetting<Partial<PilotSettings>>(userId, KEY)) ?? {}) };
}

export async function updatePilot(userId: string, patch: Partial<Omit<PilotSettings, 'conversationId' | 'lastEventAt'>>) {
  const current = await getPilot(userId);
  if (patch.workspaceIds) {
    const owned = new Set((await ownerWorkspaces(userId)).map((workspace) => workspace.id));
    if (patch.workspaceIds.some((id) => !owned.has(id))) throw new HttpError(400, 'Workspace inválido.');
  }
  const next = { ...current, ...patch };
  await setUserSetting(userId, KEY, next);
  return next;
}

async function scopeOf(userId: string, settings: PilotSettings) {
  const workspaces = await ownerWorkspaces(userId);
  return workspaces.filter((workspace) => settings.allWorkspaces || settings.workspaceIds.includes(workspace.id));
}

const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

interface PilotEvent {
  key: string;
  line: string;
}

async function collectEvents(userId: string, workspaces: { id: string; name: string }[]): Promise<PilotEvent[]> {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const pending = await pendingItems(userId, workspaces.map((workspace) => workspace.id));
  return [
    ...pending.questions.map((entry) => ({
      key: `q:${entry.agentId}:${hash(entry.questions)}`,
      line: `- Pergunta de agente em ${names.get(entry.workspaceId)}: "${entry.title}" (execução ${entry.agentId}; ${entry.questions.length} pergunta(s)). Veja com studio_agent e responda com studio_answer.`,
    })),
    ...pending.failedRuns.map((entry) => ({
      key: `run:${entry.runId}`,
      line: `- Execução de workflow falhou em ${names.get(entry.workspaceId)}: "${entry.title}" (${entry.workflow}; run ${entry.runId}${entry.executionId ? `; execução ${entry.executionId}` : ''}). Erro: ${(entry.error ?? 'sem mensagem').slice(0, 300)}`,
    })),
    ...pending.capacitySuggestions.map((entry) => ({
      key: `cap:${entry.proposalId}`,
      line: `- Sugestão do Gestor de Capacidade em ${names.get(entry.workspaceId)}: "${entry.summary}" (proposalId ${entry.proposalId}). Decida com studio_capacity.`,
    })),
  ];
}

/** Today's pilot conversation, started when there is none (or the last one is old or ended). */
async function pilotConversation(userId: string, settings: PilotSettings, workspaceId: string, firstMessage: string) {
  const current = settings.conversationId ? await prisma.agent.findUnique({ where: { id: settings.conversationId } }) : null;
  const usable = current && current.kind === 'ASSISTANT' && !['CANCELLED', 'FAILED'].includes(current.status) && Date.now() - current.createdAt.getTime() < CONVERSATION_MAX_AGE_MS;
  if (usable) return { conversation: current, started: false };
  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const conversation = await startConversation(workspaceId, firstMessage, undefined, { model: settings.model, title: `Piloto ${today}` });
  await setUserSetting(userId, KEY, { ...settings, conversationId: conversation.id });
  return { conversation, started: true };
}

function pilotMessage(settings: PilotSettings, events: PilotEvent[]) {
  return [
    '[Piloto] Novos eventos para você resolver em nome do usuário, seguindo o MODO PILOTO:',
    ...events.map((event) => event.line),
    ...(settings.instructions.trim() ? ['', `Regras do usuário para o piloto: ${settings.instructions.trim()}`] : []),
  ].join('\n');
}

async function tickUser(userId: string, settings: PilotSettings, log: FastifyBaseLogger) {
  const workspaces = await scopeOf(userId, settings);
  if (workspaces.length === 0) return;
  const events = await collectEvents(userId, workspaces);
  if (events.length === 0) return;
  const seen = await prisma.orbiPilotEvent.findMany({ where: { ownerId: userId, key: { in: events.map((event) => event.key) } }, select: { key: true } });
  const fresh = events.filter((event) => !seen.some((entry) => entry.key === event.key));
  if (fresh.length === 0) return;

  // While the pilot itself waits for the user, a message would answer its question: the events wait.
  const existing = settings.conversationId ? await prisma.agent.findUnique({ where: { id: settings.conversationId }, select: { status: true } }) : null;
  if (existing?.status === 'WAITING_INPUT') return;

  const message = pilotMessage(settings, fresh);
  const { conversation, started } = await pilotConversation(userId, settings, workspaces[0]!.id, message);
  if (!started) await sendMessage(conversation.id, message);
  await prisma.orbiPilotEvent.createMany({ data: fresh.map((event) => ({ ownerId: userId, key: event.key })), skipDuplicates: true });
  await setUserSetting(userId, KEY, { ...(await getPilot(userId)), lastEventAt: new Date().toISOString() });
  log.info({ userId, events: fresh.length }, 'Órbi pilot woke up');
}

async function tick(log: FastifyBaseLogger) {
  const rows = await prisma.userSetting.findMany({ where: { key: KEY } });
  for (const row of rows) {
    const settings = { ...DEFAULTS, ...(row.value as Partial<PilotSettings>) };
    if (!settings.enabled) continue;
    await tickUser(row.userId, settings, log).catch((err: unknown) => log.warn({ err, userId: row.userId }, 'Órbi pilot round failed'));
  }
  await prisma.orbiPilotEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } });
}

export function startOrbiPilot(log: FastifyBaseLogger) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(log)
      .catch((err: unknown) => log.error({ err }, 'Órbi pilot failed'))
      .finally(() => (running = false));
  }, TICK_MS);
  return () => clearInterval(timer);
}
