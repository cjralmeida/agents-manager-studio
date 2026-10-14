import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { stopContainer } from '../../lib/docker.js';
import { addEvent, sendMessage } from '../agents/service.js';
import type { PlanUsage } from '../usage/calc.js';
import { limitResumeAt } from './limit.js';

/**
 * Plan limit: a turn that stopped because the Claude plan hit its limit is not a failure. The agent keeps its work
 * and waits; when the window resets, the Studio sends it a message and it goes on from where it stopped.
 */

const TICK_MS = 60_000;
const TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';
const RESUME_MESSAGE =
  'O limite do plano Claude renovou. Continue exatamente de onde parou: confira o estado da sua cópia (git status, ' +
  'arquivos gerados) e siga a tarefa até o fim.';

function formatTime(date: Date) {
  return date.toLocaleString('pt-BR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Marks an agent whose turn ended on the plan limit to resume when the limit resets. */
export async function holdForPlanLimit(agentId: string, errorText: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { workspace: { select: { settings: { select: { agentAccount: { select: { planUsage: true } } } } } } },
  });
  const plan = agent?.workspace.settings?.agentAccount?.planUsage as PlanUsage | null | undefined;
  const resumeAt = limitResumeAt(errorText, plan);
  await prisma.agent.update({ where: { id: agentId }, data: { limitResumeAt: resumeAt } });
  await addEvent(agentId, 'status', {
    message: `Limite do plano Claude atingido. O trabalho fica guardado e o agente retoma sozinho em ${formatTime(resumeAt)}.`,
  });
}

/** Shown on agents paused to keep the rest of the 5-hour window for the user. */
const RESERVE_PAUSE = 'Pausado para guardar o restante do plano Claude para o usuário';

/**
 * Reserve: when the 5-hour window reaches the workflow limit (WORKFLOW_PLAN_LIMIT_PERCENT), agents still working are
 * paused too (not only new ones held), so what is left of the window stays for the user. They keep their work and
 * resume by themselves when the window resets, like an agent stopped by the limit itself.
 */
async function holdAtReserve(log: FastifyBaseLogger) {
  const agents = await prisma.agent.findMany({
    where: { status: 'RUNNING', containerId: { not: null }, limitResumeAt: null },
    select: { id: true, containerId: true, workspace: { select: { settings: { select: { agentAccount: { select: { planUsage: true } } } } } } },
  });
  for (const agent of agents) {
    const plan = agent.workspace.settings?.agentAccount?.planUsage as PlanUsage | null | undefined;
    const window = plan?.windows.find((entry) => entry.key === 'five_hour' && entry.resetsAt && new Date(entry.resetsAt) > new Date());
    if (!window || window.percent < config.workflowPlanLimitPercent) continue;
    const resumeAt = new Date(window.resetsAt!);
    // Status first: the container monitor then sees a deliberate stop, not a crash to resume.
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'READY_FOR_REVIEW', errorMessage: RESERVE_PAUSE, limitResumeAt: resumeAt },
    });
    await stopContainer(agent.containerId!, 20).catch((error: unknown) => log.warn({ agentId: agent.id, err: error }, 'Stopping a paused agent failed'));
    await addEvent(agent.id, 'status', {
      message: `${RESERVE_PAUSE} (janela de 5 horas em ${Math.round(window.percent)}%, limite ${config.workflowPlanLimitPercent}%). O trabalho fica guardado e o agente retoma sozinho em ${formatTime(resumeAt)}.`,
    });
    log.info({ agentId: agent.id, percent: window.percent }, 'Agent paused to keep the plan reserve');
  }
}

async function tick(log: FastifyBaseLogger) {
  await holdAtReserve(log);
  const due = await prisma.agent.findMany({ where: { limitResumeAt: { lte: new Date() } }, select: { id: true, status: true } });
  for (const agent of due) {
    await prisma.agent.update({ where: { id: agent.id }, data: { limitResumeAt: null, errorMessage: null } });
    // Only an agent still stopped on that turn is resumed; one the user already moved on (answered, cancelled) is left alone.
    if (agent.status !== 'READY_FOR_REVIEW') continue;
    try {
      await addEvent(agent.id, 'status', { message: 'Limite do plano renovado: retomando o trabalho.' });
      await sendMessage(agent.id, RESUME_MESSAGE);
      log.info({ agentId: agent.id }, 'Agent resumed after the plan limit');
    } catch (error) {
      log.warn({ agentId: agent.id, err: error }, 'Resuming after the plan limit failed');
    }
  }
}

export function startPlanLimitResume(log: FastifyBaseLogger) {
  const timer = setInterval(() => void tick(log).catch((err: unknown) => log.error({ err }, 'Plan limit tick failed')), TICK_MS);
  return () => clearInterval(timer);
}
