import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Sentinel } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { addEvent, launchAgent, type AgentModel } from '../agents/service.js';
import { boardContext } from '../boards/service.js';
import type { StatusMap } from '../boards/types.js';
import { getResourceUsage } from '../system/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { pickTasks, taskPrompt } from './match.js';

/** Agents that are still working (a finished agent waiting for review frees its slot). */
const WORKING_STATUSES = ['PREPARING', 'RUNNING', 'WAITING_INPUT'] as const;

/** Reasons that stop every sentinel of a workspace this round, or null when they may launch. */
async function workspaceBlocker(workspaceId: string): Promise<string | null> {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { agentAccount: true } });
  if (!settings?.agentAccount) return 'Parada: o workspace não tem conta Claude configurada.';

  const plan = settings.agentAccount.planUsage as PlanUsage | null;
  const session = plan?.windows.find((window) => window.key === 'five_hour');
  if (plan?.status === 'rejected') return 'Pausada: limite do plano Claude atingido.';
  if (session && session.percent >= config.sentinelPlanLimitPercent) {
    return `Pausada: janela de 5 horas do Claude em ${Math.round(session.percent)}% (limite ${config.sentinelPlanLimitPercent}%).`;
  }

  const usage = await getResourceUsage().catch(() => null);
  if (usage && usage.launchWarnings.length > 0) return `Aguardando: ${usage.launchWarnings.join(' ')}`;
  return null;
}

function errorText(error: unknown) {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message.slice(0, 300) : String(error);
}

async function report(sentinel: Sentinel, statusMessage: string, launched = false) {
  await prisma.sentinel.update({
    where: { id: sentinel.id },
    data: { statusMessage, lastCheckedAt: new Date(), ...(launched && { lastLaunchAt: new Date() }) },
  });
}

/**
 * Evaluates the enabled sentinels of a workspace against the cached board and launches agents for
 * matching tasks. Tasks that ever had an agent are skipped, so a failed attempt is not retried in a loop.
 */
export async function runSentinels(workspaceId: string, log?: FastifyBaseLogger, onlyId?: string) {
  const sentinels = await prisma.sentinel.findMany({
    where: { workspaceId, isEnabled: true, ...(onlyId && { id: onlyId }) },
    orderBy: { createdAt: 'asc' },
  });
  if (sentinels.length === 0) return;

  const blocker = await workspaceBlocker(workspaceId);
  if (blocker) {
    for (const sentinel of sentinels) await report(sentinel, blocker);
    return;
  }

  const { board, snapshot, projectOf } = await boardContext(workspaceId);
  const statusMap = board.statusMap as StatusMap;
  const taken = new Set(
    (await prisma.agent.findMany({ where: { workspaceId, taskItemId: { not: null } }, select: { taskItemId: true } })).map(
      (agent) => agent.taskItemId!,
    ),
  );

  for (const sentinel of sentinels) {
    const working = await prisma.agent.count({ where: { sentinelId: sentinel.id, status: { in: [...WORKING_STATUSES] } } });
    const slots = sentinel.maxConcurrent - working;
    if (slots <= 0) {
      await report(sentinel, `Ocupada: ${working} agente(s) trabalhando.`);
      continue;
    }

    const columnId = sentinel.columnId ?? statusMap.todo ?? null;
    const candidates = pickTasks(snapshot.items, snapshot.fields, {
      fieldFilters: sentinel.fieldFilters as Record<string, string[]>,
      repositories: sentinel.repositories,
      columnId,
      onlyUnassigned: sentinel.onlyUnassigned,
    }).filter((item) => !taken.has(item.id) && projectOf(item) && item.columnId !== statusMap.blocked);

    if (candidates.length === 0) {
      await report(sentinel, columnId ? 'Vigiando: nenhuma tarefa nova.' : 'Parada: o quadro não tem coluna "A fazer" definida.');
      continue;
    }

    const launched: string[] = [];
    let failure: string | null = null;
    for (const item of candidates.slice(0, slots)) {
      // Claimed before launching, so another sentinel in this round skips it even if the launch fails.
      taken.add(item.id);
      try {
        const agent = await launchAgent({
          projectId: projectOf(item)!,
          title: item.title.slice(0, 120),
          prompt: taskPrompt(item, sentinel.instructions),
          model: sentinel.model as AgentModel,
          taskItemId: item.id,
          sentinelId: sentinel.id,
          // The workspace blocker already checked Docker usage; sentinels never ask for confirmation.
          confirmHighUsage: true,
        });
        await addEvent(agent.id, 'status', { message: `Lançado pela sentinela "${sentinel.name}".` });
        launched.push(item.title);
        log?.info({ sentinelId: sentinel.id, agentId: agent.id, itemId: item.id }, 'Sentinel launched an agent');
      } catch (error) {
        failure = `Erro ao lançar "${item.title}": ${errorText(error)}`;
        log?.warn({ sentinelId: sentinel.id, itemId: item.id, err: error }, 'Sentinel failed to launch an agent');
      }
    }

    const message = launched.length > 0 ? `Lançou agente para: ${launched.map((title) => `"${title}"`).join(', ')}.` : failure;
    await report(sentinel, message ?? 'Vigiando: nenhuma tarefa nova.', launched.length > 0);
  }
}
