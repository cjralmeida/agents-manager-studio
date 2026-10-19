import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { OrbiRoutine } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { getResourceUsage } from '../system/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { busiestWorkspace, deliverToOrbi, orbiState } from './conversation.js';
import { type RoutineMode, dueByInterval, dueDailyTime, routineMessage } from './routine-schedule.js';
import { ownerWorkspaces, pendingItems } from './ops.js';

/**
 * Routines: work the user gives Órbi to do by itself, on a schedule (every N minutes, every day at set times) or when
 * something happens (an agent asks, a run fails, the machine is full...). Each one has the user's instructions, the
 * workspaces it watches and a mode: "auto" decides and acts, "assistant" leaves the options for the user and waits.
 * They all run in the user's one Órbi conversation, one at a time: while Órbi is busy or waiting for the user, a due
 * routine waits for the next round.
 */

export const ROUTINE_EVENTS = {
  agent_question: 'Um agente fez uma pergunta',
  failed_run: 'Uma execução de workflow falhou',
  agent_stopped: 'Um agente parou sem container',
  machine: 'Memória ou CPU do computador no limite',
  plan: 'Plano Claude perto do limite',
  test_env: 'Ambiente de teste preso',
  capacity: 'O Gestor de Capacidade sugere mudar os agentes de uma etapa',
} as const;
export type RoutineEvent = keyof typeof ROUTINE_EVENTS;

const TICK_MS = 60_000;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** An agent marked as working with no container for this long has stopped (not a pause the user asked for). */
const STOPPED_AFTER_MS = 15 * 60_000;
/** A test environment still building or queued after this long is stuck. */
const TEST_ENV_STUCK_MS = 45 * 60_000;

export type { RoutineMode };

export interface RoutineInput {
  name: string;
  instructions: string;
  workspaceIds: string[];
  everyMinutes: number | null;
  dailyAt: string[];
  events: RoutineEvent[];
  mode: RoutineMode;
  enabled: boolean;
}

// ---------------------------------------------------------------- CRUD

async function checkWorkspaces(ownerId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const owned = new Set((await ownerWorkspaces(ownerId)).map((workspace) => workspace.id));
  if (ids.some((id) => !owned.has(id))) throw new HttpError(400, 'Workspace inválido.');
}

async function ownedRoutine(ownerId: string, id: string) {
  const routine = await prisma.orbiRoutine.findFirst({ where: { id, ownerId } });
  if (!routine) throw notFound('Rotina não encontrada.');
  return routine;
}

export async function listRoutines(ownerId: string) {
  await migratePilots(ownerId);
  return prisma.orbiRoutine.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } });
}

export async function createRoutine(ownerId: string, input: RoutineInput) {
  await checkWorkspaces(ownerId, input.workspaceIds);
  return prisma.orbiRoutine.create({ data: { ownerId, ...input, dailyAt: [...new Set(input.dailyAt)].sort() } });
}

export async function updateRoutine(ownerId: string, id: string, patch: Partial<RoutineInput>) {
  await ownedRoutine(ownerId, id);
  await checkWorkspaces(ownerId, patch.workspaceIds);
  return prisma.orbiRoutine.update({ where: { id }, data: { ...patch, ...(patch.dailyAt && { dailyAt: [...new Set(patch.dailyAt)].sort() }) } });
}

export async function deleteRoutine(ownerId: string, id: string) {
  await ownedRoutine(ownerId, id);
  await prisma.orbiRoutine.delete({ where: { id } });
}

/** "Rodar agora": the routine goes to Órbi right away, whatever its schedule. */
export async function runRoutineNow(ownerId: string, id: string) {
  const routine = await ownedRoutine(ownerId, id);
  const workspaces = await scopeOf(ownerId, routine);
  if (workspaces.length === 0) throw new HttpError(422, 'A rotina não tem workspace para olhar.');
  const events = await collectEvents(ownerId, workspaces, routine.events as RoutineEvent[]);
  await deliverToOrbi(ownerId, routineMessage(routine, workspaces, ['você pediu para rodar agora'], events.map((event) => event.line)), (await busiestWorkspace(workspaces))!.id);
  await markSeen(ownerId, routine.id, events);
  return prisma.orbiRoutine.update({ where: { id }, data: { lastRunAt: new Date() } });
}

// ---------------------------------------------------------------- what wakes a routine

interface RoutineEventItem {
  key: string;
  line: string;
}

async function scopeOf(ownerId: string, routine: Pick<OrbiRoutine, 'workspaceIds'>) {
  const workspaces = await ownerWorkspaces(ownerId);
  return routine.workspaceIds.length === 0 ? workspaces : workspaces.filter((workspace) => routine.workspaceIds.includes(workspace.id));
}

const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** What happened in the routine's workspaces, for the events it watches (keys tell an event already handled). */
export async function collectEvents(ownerId: string, workspaces: { id: string; name: string }[], kinds: RoutineEvent[]): Promise<RoutineEventItem[]> {
  if (kinds.length === 0 || workspaces.length === 0) return [];
  const wants = new Set(kinds);
  const ids = workspaces.map((workspace) => workspace.id);
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const events: RoutineEventItem[] = [];

  if (wants.has('agent_question') || wants.has('failed_run') || wants.has('capacity')) {
    const pending = await pendingItems(ownerId, ids);
    if (wants.has('agent_question')) {
      for (const entry of pending.questions) {
        events.push({
          key: `q:${entry.agentId}:${hash(entry.questions)}`,
          line: `- Pergunta de agente em ${names.get(entry.workspaceId)}: "${entry.title}" (execução ${entry.agentId}; ${entry.questions.length} pergunta(s)). Veja com studio_agent; responda com studio_answer.`,
        });
      }
    }
    if (wants.has('failed_run')) {
      for (const entry of pending.failedRuns) {
        events.push({
          key: `run:${entry.runId}`,
          line: `- Execução de workflow falhou em ${names.get(entry.workspaceId)}: "${entry.title}" (${entry.workflow}; run ${entry.runId}${entry.executionId ? `; execução ${entry.executionId}` : ''}). Erro: ${(entry.error ?? 'sem mensagem').slice(0, 300)}`,
        });
      }
    }
    if (wants.has('capacity')) {
      for (const entry of pending.capacitySuggestions) {
        events.push({
          key: `capacity:${entry.proposalId}`,
          line: `- Gestor de Capacidade em ${names.get(entry.workspaceId)} (sugestão ${entry.proposalId}): ${entry.summary.split('\n').join('; ')}. Aplique ou descarte com studio_capacity, ou ajuste você com studio_set_workflow (stepAgents); veja studio_resources antes de subir agentes.`,
        });
      }
    }
  }

  if (wants.has('agent_stopped')) {
    const paused = (await getUserSetting<Record<string, unknown>>(ownerId, 'orbiPaused')) ?? {};
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
  }

  const hour = new Date().toISOString().slice(0, 13);
  if (wants.has('machine')) {
    const usage = await getResourceUsage().catch(() => null);
    const memory = usage ? (usage.host?.memoryPercent ?? usage.totals.memoryPercent) : null;
    if (memory !== null && memory >= config.launchMemoryPercent) {
      events.push({
        key: `memory:${hour}`,
        line: `- Memória do computador em ${Math.round(memory)}% (limite de lançamento ${config.launchMemoryPercent}%): veja studio_resources e studio_overview; desça agentes de alguma etapa (studio_set_workflow stepAgents) ou derrube ambientes de teste que sobraram.`,
      });
    }
    // CPU jumps between samples: it only counts when it is high and the memory is not already the reason above.
    const cpu = usage ? (usage.host?.cpuPercent ?? usage.totals.cpuPercent) : null;
    if (cpu !== null && cpu >= config.launchCpuPercent && !(memory !== null && memory >= config.launchMemoryPercent)) {
      events.push({
        key: `cpu:${hour}`,
        line: `- CPU do computador em ${Math.round(cpu)}% (limite de lançamento ${config.launchCpuPercent}%): testes que rodam num navegador ficam lentos e falham por tempo. Veja studio_overview; se continuar alta, desça um agente de uma etapa que não seja de teste (studio_set_workflow stepAgents).`,
      });
    }
  }

  if (wants.has('plan')) {
    const accounts = await prisma.agentAccount.findMany({ where: { ownerId }, select: { label: true, planUsage: true } });
    for (const account of accounts) {
      const session = (account.planUsage as PlanUsage | null)?.windows.find((window) => window.key === 'five_hour')?.percent ?? null;
      if (session !== null && session >= config.workflowPlanLimitPercent - 5) {
        events.push({
          key: `plan:${account.label}:${hour}`,
          line: `- Plano Claude "${account.label}" com a janela de 5 h em ${Math.round(session)}% (os workflows pausam em ${config.workflowPlanLimitPercent}%): diminua agentes onde der menos prejuízo.`,
        });
      }
    }
  }

  if (wants.has('test_env')) {
    const stuck = await prisma.testEnvironment.findMany({
      where: { workspaceId: { in: ids }, status: { in: ['queued', 'building'] }, createdAt: { lt: new Date(Date.now() - TEST_ENV_STUCK_MS) } },
      select: { id: true, status: true, workspaceId: true, createdAt: true },
    });
    for (const env of stuck) {
      events.push({
        key: `env:${env.id}:${env.status}`,
        line: `- Ambiente de teste ${env.id} em ${names.get(env.workspaceId)} está "${env.status}" desde ${env.createdAt.toISOString()}: veja studio_resources.`,
      });
    }
  }
  return events;
}

const eventKey = (routineId: string, key: string) => `routine:${routineId}:${key}`;

async function freshEvents(ownerId: string, routineId: string, events: RoutineEventItem[]) {
  if (events.length === 0) return [];
  const seen = await prisma.orbiPilotEvent.findMany({ where: { ownerId, key: { in: events.map((event) => eventKey(routineId, event.key)) } }, select: { key: true } });
  const done = new Set(seen.map((entry) => entry.key));
  return events.filter((event) => !done.has(eventKey(routineId, event.key)));
}

async function markSeen(ownerId: string, routineId: string, events: RoutineEventItem[]) {
  if (events.length === 0) return;
  await prisma.orbiPilotEvent.createMany({ data: events.map((event) => ({ ownerId, key: eventKey(routineId, event.key) })), skipDuplicates: true });
}

// ---------------------------------------------------------------- the round

async function tickRoutine(routine: OrbiRoutine, log: FastifyBaseLogger) {
  const workspaces = await scopeOf(routine.ownerId, routine);
  if (workspaces.length === 0) return false;
  const reasons: string[] = [];
  if (dueByInterval(routine.everyMinutes, routine.lastRunAt)) reasons.push(`roda a cada ${routine.everyMinutes} min`);
  const daily = dueDailyTime(routine.dailyAt, routine.lastRunAt, routine.createdAt);
  if (daily) reasons.push(`horário agendado ${daily}`);
  const events = await freshEvents(routine.ownerId, routine.id, await collectEvents(routine.ownerId, workspaces, routine.events as RoutineEvent[]));
  if (reasons.length === 0 && events.length === 0) return false;

  // One message at a time: while Órbi works or waits for the user, the routine (and its events) wait for the next round.
  const state = await orbiState(routine.ownerId);
  if (state === 'busy' || state === 'waiting') return false;

  await deliverToOrbi(routine.ownerId, routineMessage(routine, workspaces, reasons, events.map((event) => event.line)), (await busiestWorkspace(workspaces))!.id);
  await markSeen(routine.ownerId, routine.id, events);
  await prisma.orbiRoutine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
  log.info({ routine: routine.name, ownerId: routine.ownerId, events: events.length, reasons }, 'Órbi routine ran');
  return true;
}

async function tick(log: FastifyBaseLogger) {
  // Users who had a pilot switched on keep it running as a routine, even before they open the Órbi page.
  const withPilots = await prisma.userSetting.findMany({ where: { key: { in: ['orbiPilot', 'orbiPilotAgents'] } }, select: { userId: true }, distinct: ['userId'] });
  for (const { userId } of withPilots) await migratePilots(userId).catch((err: unknown) => log.warn({ err, userId }, 'Pilot migration failed'));
  const routines = await prisma.orbiRoutine.findMany({ where: { enabled: true }, orderBy: [{ lastRunAt: { sort: 'asc', nulls: 'first' } }] });
  // One routine per user per round: the conversation is busy once it got one.
  const served = new Set<string>();
  for (const routine of routines) {
    if (served.has(routine.ownerId)) continue;
    const ran = await tickRoutine(routine, log).catch((err: unknown) => {
      log.warn({ err, routine: routine.id }, 'Órbi routine failed');
      return false;
    });
    if (ran) served.add(routine.ownerId);
  }
  await prisma.orbiPilotEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } });
}

export function startOrbiRoutines(log: FastifyBaseLogger) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(log)
      .catch((err: unknown) => log.error({ err }, 'Órbi routines failed'))
      .finally(() => (running = false));
  }, TICK_MS);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- the two old pilots become routines

const MIGRATED_KEY = 'orbiRoutinesMigrated';

interface OldPilot {
  enabled?: boolean;
  allWorkspaces?: boolean;
  workspaceIds?: string[];
  mode?: 'technical' | 'full';
  instructions?: string;
}

/**
 * Once per user: the Gerenciador de Fila and the Autoscaler (the old pilots, with their switches, workspaces and rules)
 * become the first two routines.
 */
export async function migratePilots(ownerId: string) {
  if (await getUserSetting<boolean>(ownerId, MIGRATED_KEY)) return;
  if ((await prisma.orbiRoutine.count({ where: { ownerId } })) === 0) {
    const [tasks, agents] = await Promise.all([getUserSetting<OldPilot>(ownerId, 'orbiPilot'), getUserSetting<OldPilot>(ownerId, 'orbiPilotAgents')]);
    const scope = (pilot: OldPilot | null) => (pilot && pilot.allWorkspaces === false ? (pilot.workspaceIds ?? []) : []);
    const rules = (pilot: OldPilot | null, technical: string) =>
      [pilot?.mode === 'full' ? '' : technical, pilot?.instructions?.trim() ?? ''].filter(Boolean).join('\n');
    await prisma.orbiRoutine.createMany({
      data: [
        {
          ownerId,
          name: 'Gerenciador de Fila',
          instructions: rules(
            tasks,
            'Cuide do trabalho no quadro: execuções que falharam e reprovações no HOM, conflitos de merge (studio_conflict_back), tarefas travadas e publicação. Perguntas dos agentes e decisões de regra de negócio, escopo, prioridade, design ou critério de aceite não são suas: deixe-as como decisão para o usuário.',
          ),
          workspaceIds: scope(tasks),
          events: tasks?.mode === 'full' ? ['failed_run', 'agent_question'] : ['failed_run'],
          mode: 'auto',
          enabled: Boolean(tasks?.enabled),
        },
        {
          ownerId,
          name: 'Autoscaler',
          instructions: rules(
            agents,
            'Cuide de quem trabalha e quanto: agentes por etapa (sugestões do Gestor de Capacidade), agentes parados sem container, memória, CPU e plano Claude perto do limite, ambientes de teste presos. Pausar um workspace inteiro vira decisão para o usuário.',
          ),
          workspaceIds: scope(agents),
          events: ['capacity', 'agent_stopped', 'machine', 'plan', 'test_env'],
          mode: 'auto',
          enabled: Boolean(agents?.enabled),
        },
      ],
    });
  }
  await setUserSetting(ownerId, MIGRATED_KEY, true);
}
