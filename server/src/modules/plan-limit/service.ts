import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
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

async function tick(log: FastifyBaseLogger) {
  const due = await prisma.agent.findMany({ where: { limitResumeAt: { lte: new Date() } }, select: { id: true, status: true } });
  for (const agent of due) {
    await prisma.agent.update({ where: { id: agent.id }, data: { limitResumeAt: null } });
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
