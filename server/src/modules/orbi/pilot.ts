import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { sendMessage } from '../agents/service.js';
import { startConversation } from '../assistant/service.js';
import { getResourceUsage } from '../system/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { ownerWorkspaces, pendingItems } from './ops.js';

/**
 * Órbi's two pilots. While one is on, Órbi wakes by itself for its kind of event and deals with it with its tools,
 * leaving the activity log as the report. Each has its own conversation per day, switch, workspaces and rules.
 * - Tasks pilot: the work on the board — agent questions on tasks (only while the user is away), failed runs and
 *   homologation reports, merge conflicts, stuck tasks, publishing problems.
 * - Agents pilot: who works and how much — agents per step (Gestor de Capacidade), agents stopped without a
 *   container, the computer and the Claude plan near their limits, stuck test environments.
 */

export type PilotKind = 'tasks' | 'agents';
export const PILOT_KINDS: readonly PilotKind[] = ['tasks', 'agents'];

const KEYS: Record<PilotKind, string> = { tasks: 'orbiPilot', agents: 'orbiPilotAgents' };
const TITLES: Record<PilotKind, string> = { tasks: 'Piloto de tarefas', agents: 'Piloto de agentes' };
const TICK_MS = 60_000;
const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** An agent marked as working with no container for this long has stopped (not a pause the user asked for). */
const STOPPED_AFTER_MS = 15 * 60_000;
/** A test environment still building or queued after this long is stuck. */
const TEST_ENV_STUCK_MS = 45 * 60_000;

export interface PilotSettings {
  enabled: boolean;
  /** All the user's workspaces, or only workspaceIds. */
  allWorkspaces: boolean;
  workspaceIds: string[];
  model: 'sonnet' | 'opus';
  /**
   * Tasks pilot: "technical" while the user is around (agent questions and rule decisions stay with them); "full"
   * while away (everything). The agents pilot only makes technical decisions.
   */
  mode: 'technical' | 'full';
  /** The user's own rules for the pilot. */
  instructions: string;
  conversationId: string | null;
  lastEventAt: string | null;
}

const DEFAULTS: PilotSettings = { enabled: false, allWorkspaces: true, workspaceIds: [], model: 'sonnet', mode: 'technical', instructions: '', conversationId: null, lastEventAt: null };

export async function getPilot(userId: string, kind: PilotKind): Promise<PilotSettings> {
  return { ...DEFAULTS, ...((await getUserSetting<Partial<PilotSettings>>(userId, KEYS[kind])) ?? {}) };
}

export async function updatePilot(userId: string, kind: PilotKind, patch: Partial<Omit<PilotSettings, 'conversationId' | 'lastEventAt'>>) {
  const current = await getPilot(userId, kind);
  if (patch.workspaceIds) {
    const owned = new Set((await ownerWorkspaces(userId)).map((workspace) => workspace.id));
    if (patch.workspaceIds.some((id) => !owned.has(id))) throw new HttpError(400, 'Workspace inválido.');
  }
  const next = { ...current, ...patch };
  await setUserSetting(userId, KEYS[kind], next);
  return next;
}

/** Ids of the conversations of both pilots (shown first on the Órbi page). */
export async function pilotConversationIds(userId: string) {
  const [tasks, agents] = await Promise.all(PILOT_KINDS.map((kind) => getPilot(userId, kind)));
  return { tasks: tasks!.conversationId, agents: agents!.conversationId };
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

async function taskEvents(userId: string, workspaces: { id: string; name: string }[], mode: PilotSettings['mode']): Promise<PilotEvent[]> {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const pending = await pendingItems(userId, workspaces.map((workspace) => workspace.id));
  // With the user around, agent questions (decisions) are theirs: the pilot only gets the technical problems.
  const questions = mode === 'full' ? pending.questions : [];
  return [
    ...questions.map((entry) => ({
      key: `q:${entry.agentId}:${hash(entry.questions)}`,
      line: `- Pergunta de agente em ${names.get(entry.workspaceId)}: "${entry.title}" (execução ${entry.agentId}; ${entry.questions.length} pergunta(s)). Veja com studio_agent e responda com studio_answer.`,
    })),
    ...pending.failedRuns.map((entry) => ({
      key: `run:${entry.runId}`,
      line: `- Execução de workflow falhou em ${names.get(entry.workspaceId)}: "${entry.title}" (${entry.workflow}; run ${entry.runId}${entry.executionId ? `; execução ${entry.executionId}` : ''}). Erro: ${(entry.error ?? 'sem mensagem').slice(0, 300)}`,
    })),
  ];
}

/** Agents stopped mid-work, the computer and the plan at their limits, stuck test environments. */
async function agentEvents(userId: string, workspaces: { id: string; name: string }[]): Promise<PilotEvent[]> {
  const ids = workspaces.map((workspace) => workspace.id);
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const paused = (await getUserSetting<Record<string, unknown>>(userId, 'orbiPaused')) ?? {};
  const events: PilotEvent[] = [];

  // Marked as working, no container, nothing queued for it (the monitor starts those), not held for the plan, not in
  // a paused workspace nor a switched-off workflow (standby the user asked for).
  const stopped = await prisma.agent.findMany({
    where: {
      workspaceId: { in: ids.filter((id) => !paused[id]) },
      kind: 'TASK',
      status: { in: ['PREPARING', 'RUNNING'] },
      containerId: null,
      limitResumeAt: null,
      lastActivityAt: { lt: new Date(Date.now() - STOPPED_AFTER_MS) },
      inbox: { none: { deliveredAt: null } },
      OR: [{ workflowRunId: null }, { workflowRun: { workflow: { isEnabled: true } } }],
    },
    select: { id: true, title: true, workspaceId: true, lastActivityAt: true },
  });
  for (const agent of stopped) {
    events.push({
      key: `stopped:${agent.id}:${agent.lastActivityAt.toISOString()}`,
      line: `- Agente parado sem container em ${names.get(agent.workspaceId)}: "${agent.title}" (execução ${agent.id}; última atividade ${agent.lastActivityAt.toISOString()}). Veja com studio_agent e retome com studio_message se fizer sentido.`,
    });
  }

  const hour = new Date().toISOString().slice(0, 13);
  const usage = await getResourceUsage().catch(() => null);
  const memory = usage ? (usage.host?.memoryPercent ?? usage.totals.memoryPercent) : null;
  if (memory !== null && memory >= config.launchMemoryPercent) {
    events.push({
      key: `memory:${hour}`,
      line: `- Memória do computador em ${Math.round(memory)}% (limite de lançamento ${config.launchMemoryPercent}%): veja studio_resources e studio_overview; desça agentes de alguma etapa (studio_set_workflow stepAgents) ou derrube ambientes de teste que sobraram.`,
    });
  }
  const accounts = await prisma.agentAccount.findMany({ where: { ownerId: userId }, select: { label: true, planUsage: true } });
  for (const account of accounts) {
    const session = (account.planUsage as PlanUsage | null)?.windows.find((window) => window.key === 'five_hour')?.percent ?? null;
    if (session !== null && session >= config.workflowPlanLimitPercent - 5) {
      events.push({
        key: `plan:${account.label}:${hour}`,
        line: `- Plano Claude "${account.label}" com a janela de 5 h em ${Math.round(session)}% (os workflows pausam em ${config.workflowPlanLimitPercent}%): diminua agentes onde der menos prejuízo, ou deixe um aviso para o usuário.`,
      });
    }
  }

  const stuckEnvs = await prisma.testEnvironment.findMany({
    where: { workspaceId: { in: ids }, status: { in: ['queued', 'building'] }, createdAt: { lt: new Date(Date.now() - TEST_ENV_STUCK_MS) } },
    select: { id: true, status: true, workspaceId: true, createdAt: true },
  });
  for (const env of stuckEnvs) {
    events.push({
      key: `env:${env.id}:${env.status}`,
      line: `- Ambiente de teste ${env.id} em ${names.get(env.workspaceId)} está "${env.status}" desde ${env.createdAt.toISOString()}: veja studio_resources; se estiver preso, deixe um aviso para o usuário.`,
    });
  }
  return events;
}

/** Today's conversation of a pilot, started when there is none (or the last one is old or ended). */
async function pilotConversation(userId: string, kind: PilotKind, settings: PilotSettings, workspaceId: string, firstMessage: string) {
  const current = settings.conversationId ? await prisma.agent.findUnique({ where: { id: settings.conversationId } }) : null;
  const usable = current && current.kind === 'ASSISTANT' && !['CANCELLED', 'FAILED'].includes(current.status) && Date.now() - current.createdAt.getTime() < CONVERSATION_MAX_AGE_MS;
  if (usable) return { conversation: current, started: false };
  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const conversation = await startConversation(workspaceId, firstMessage, undefined, { model: settings.model, title: `${TITLES[kind]} ${today}` });
  await setUserSetting(userId, KEYS[kind], { ...settings, conversationId: conversation.id });
  return { conversation, started: true };
}

function pilotMessage(kind: PilotKind, settings: PilotSettings, lines: string[]) {
  const head =
    kind === 'agents'
      ? '[Piloto de agentes] Eventos sobre agentes, capacidade e recursos. Resolva seguindo o PILOTO DE AGENTES; o que for decisão de regra, escopo ou negócio vai para o usuário com studio_flag:'
      : settings.mode === 'technical'
        ? '[Piloto técnico] O usuário está por aqui. Resolva só os problemas técnicos destes eventos, seguindo o MODO PILOTO (técnico); decisões de regra, escopo ou negócio vão para ele com studio_flag:'
        : '[Piloto] Novos eventos para você resolver em nome do usuário, seguindo o MODO PILOTO:';
  return [head, ...lines, ...(settings.instructions.trim() ? ['', `Regras do usuário para o piloto: ${settings.instructions.trim()}`] : [])].join('\n');
}

async function deliver(userId: string, kind: PilotKind, settings: PilotSettings, workspaceId: string, lines: string[]) {
  const message = pilotMessage(kind, settings, lines);
  const { conversation, started } = await pilotConversation(userId, kind, settings, workspaceId, message);
  if (!started) await sendMessage(conversation.id, message);
  await setUserSetting(userId, KEYS[kind], { ...(await getPilot(userId, kind)), lastEventAt: new Date().toISOString() });
}

/**
 * Hands an event from another part of the Studio (e.g. the Gestor de Capacidade) to a pilot, when it is on and covers
 * the workspace. Returns whether the pilot got it.
 */
export async function notifyPilot(userId: string, kind: PilotKind, workspaceId: string, lines: string[]) {
  const settings = await getPilot(userId, kind);
  if (!settings.enabled) return false;
  const workspaces = await scopeOf(userId, settings);
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) return false;
  const existing = settings.conversationId ? await prisma.agent.findUnique({ where: { id: settings.conversationId }, select: { status: true } }) : null;
  if (existing?.status === 'WAITING_INPUT') return false;
  await deliver(userId, kind, settings, workspaceId, lines);
  return true;
}

async function tickUser(userId: string, kind: PilotKind, settings: PilotSettings, log: FastifyBaseLogger) {
  const workspaces = await scopeOf(userId, settings);
  if (workspaces.length === 0) return;
  const events = kind === 'tasks' ? await taskEvents(userId, workspaces, settings.mode) : await agentEvents(userId, workspaces);
  if (events.length === 0) return;
  const keys = events.map((event) => `${kind}:${event.key}`);
  const seen = await prisma.orbiPilotEvent.findMany({ where: { ownerId: userId, key: { in: keys } }, select: { key: true } });
  const fresh = events.filter((event) => !seen.some((entry) => entry.key === `${kind}:${event.key}`));
  if (fresh.length === 0) return;

  // While the pilot itself waits for the user, a message would answer its question: the events wait.
  const existing = settings.conversationId ? await prisma.agent.findUnique({ where: { id: settings.conversationId }, select: { status: true } }) : null;
  if (existing?.status === 'WAITING_INPUT') return;

  await deliver(userId, kind, settings, workspaces[0]!.id, fresh.map((event) => event.line));
  await prisma.orbiPilotEvent.createMany({ data: fresh.map((event) => ({ ownerId: userId, key: `${kind}:${event.key}` })), skipDuplicates: true });
  log.info({ userId, kind, events: fresh.length }, 'Órbi pilot woke up');
}

async function tick(log: FastifyBaseLogger) {
  for (const kind of PILOT_KINDS) {
    const rows = await prisma.userSetting.findMany({ where: { key: KEYS[kind] } });
    for (const row of rows) {
      const settings = { ...DEFAULTS, ...(row.value as Partial<PilotSettings>) };
      if (!settings.enabled) continue;
      await tickUser(row.userId, kind, settings, log).catch((err: unknown) => log.warn({ err, userId: row.userId, kind }, 'Órbi pilot round failed'));
    }
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
