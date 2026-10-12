import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { addEvent, answerQuestion } from '../agents/service.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';

/**
 * Automatic answers: when the user does not answer an agent's question within the chosen time, the Studio answers
 * for them — the option marked as recommended, or the approval option ("Aprovar") — so the work goes on while they
 * are away. Off by default; set per user in Configurações.
 */

const KEY = 'autoAnswerMinutes';
const TICK_MS = 60_000;

export interface AgentQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export async function getAutoAnswer(userId: string) {
  return { minutes: (await getUserSetting<number>(userId, KEY)) ?? null };
}

export async function setAutoAnswer(userId: string, minutes: number | null) {
  await setUserSetting(userId, KEY, minutes);
  return getAutoAnswer(userId);
}

/** The answer the user would most likely give: the recommended option, else the approval, else the first option. */
export function chooseAnswer(question: AgentQuestion) {
  const options = question.options ?? [];
  const recommended = options.find((option) => /recomendad|recommended/i.test(`${option.label} ${option.description ?? ''}`));
  const approval = options.find((option) => /^(aprovar|aprovado|approve|sim|seguir|continuar|prosseguir)\b/i.test(option.label.trim()));
  const chosen = recommended ?? approval ?? options[0];
  return chosen ? chosen.label : 'Siga com a opção que você recomenda.';
}

async function tick(log: FastifyBaseLogger) {
  const waiting = await prisma.agent.findMany({
    where: { status: 'WAITING_INPUT' },
    select: { id: true, pendingQuestion: true, workspace: { select: { ownerId: true } } },
  });
  const minutesByOwner = new Map<string, number | null>();
  for (const agent of waiting) {
    const questions = Array.isArray(agent.pendingQuestion) ? (agent.pendingQuestion as unknown as AgentQuestion[]) : [];
    if (questions.length === 0) continue;
    const ownerId = agent.workspace.ownerId;
    if (!minutesByOwner.has(ownerId)) minutesByOwner.set(ownerId, (await getAutoAnswer(ownerId)).minutes);
    const minutes = minutesByOwner.get(ownerId);
    if (!minutes) continue;
    const asked = await prisma.agentEvent.findFirst({ where: { agentId: agent.id, type: 'question' }, orderBy: { id: 'desc' }, select: { createdAt: true } });
    if (!asked || Date.now() - asked.createdAt.getTime() < minutes * 60_000) continue;

    const answers = Object.fromEntries(
      questions.map((question) => [
        question.question,
        `${chooseAnswer(question)} — resposta automática do Studio: o usuário não respondeu em ${minutes} min. Siga com esta opção; ` +
          'se for uma aprovação, considere aprovado e registre no resultado que foi aprovado automaticamente, para o usuário revisar quando voltar.',
      ]),
    );
    try {
      await addEvent(agent.id, 'status', { message: `Sem resposta em ${minutes} min: o Studio respondeu pela opção recomendada (resposta automática).` });
      await answerQuestion(agent.id, answers);
      log.info({ agentId: agent.id, minutes }, 'Question answered automatically');
    } catch (error) {
      log.warn({ agentId: agent.id, err: error }, 'Automatic answer failed');
    }
  }
}

export function startAutoAnswer(log: FastifyBaseLogger) {
  const timer = setInterval(() => void tick(log).catch((err: unknown) => log.error({ err }, 'Automatic answers tick failed')), TICK_MS);
  return () => clearInterval(timer);
}
