import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { git } from '../../lib/git.js';
import { launchAgent } from '../agents/service.js';
import { workdirPath } from '../agents/workdir.js';
import type { BoardItem } from '../boards/types.js';
import type { PlanUsage } from '../usage/calc.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { type BoardTaskState, boardTaskQueue, boardTaskState, parseTrigger, workspaceBlocker } from '../workflows/engine.js';
import { type CapacitySignal, type PlanState, type WorkflowLoad, capacitySignals, signalsSignature } from './signals.js';

/** How often the workspaces are looked at (plain rules, no AI). */
const TICK_MS = 3 * 60_000;
/** Least time between two analyses by the agent in a workspace. */
const COOLDOWN_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_BODY = 1_500;
const MAX_FILES = 40;

const ACTIVE_AGENT = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING'] as const;
const ref = (item: BoardItem) => (item.repository && item.number ? `${item.repository}#${item.number}` : item.id);

async function planState(workspaceId: string): Promise<PlanState> {
  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, include: { agentAccount: true } });
  const plan = settings?.agentAccount?.planUsage as PlanUsage | null | undefined;
  const percent = (key: string) => plan?.windows.find((window) => window.key === key)?.percent ?? null;
  return { sessionPercent: percent('five_hour'), weekPercent: percent('seven_day'), limitPercent: config.workflowPlanLimitPercent };
}

/** The board workflows of the workspace with their queue: busy slots, tasks ready, tasks waiting. */
async function workflowLoads(workspaceId: string, state: BoardTaskState) {
  const workflows = await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true }, orderBy: { createdAt: 'asc' } });
  const since = new Date(Date.now() - DAY_MS);
  const loads: (WorkflowLoad & { readyItems: BoardItem[] })[] = [];
  for (const workflow of workflows) {
    const trigger = parseTrigger(workflow);
    if (trigger.type !== 'board_task') continue;
    const queue = boardTaskQueue(trigger, state);
    const conflict = { contains: 'conflit', mode: 'insensitive' } as const;
    const [running, recentConflicts] = await Promise.all([
      prisma.workflowRun.count({ where: { workflowId: workflow.id, status: 'RUNNING' } }),
      prisma.workflowRun.count({
        where: { workflowId: workflow.id, status: 'FAILED', finishedAt: { gte: since }, OR: [{ error: conflict }, { steps: { some: { error: conflict } } }] },
      }),
    ]);
    loads.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      max: workflow.maxConcurrentRuns,
      running,
      ready: queue.ready.map((item) => ({ ref: ref(item), title: item.title })),
      readyItems: queue.ready,
      waiting: queue.waiting.length,
      recentConflicts,
    });
  }
  return loads;
}

/** Files an agent changed so far (read only: nothing is staged in its copy). */
async function changedFiles(workdir: string, baseCommit: string) {
  const dir = workdirPath(workdir);
  const [changed, created] = await Promise.all([
    git(dir, ['diff', '--name-only', baseCommit]).catch(() => ''),
    git(dir, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
  ]);
  return [...new Set(`${changed}\n${created}`.split('\n').filter(Boolean))];
}

const hasBase = (agent: { baseCommit: string | null }) => Boolean(agent.baseCommit && agent.baseCommit !== 'none');

/**
 * What the workflow is doing now: each running task and the files it touched. A step that continues the previous
 * agent's branch (e.g. the tester) starts from that agent's work, so the task's changes count from the run's first agent.
 */
async function runningWork(workflowId: string) {
  const runs = await prisma.workflowRun.findMany({
    where: { workflowId, status: 'RUNNING' },
    select: { title: true, agents: { orderBy: { createdAt: 'asc' }, select: { status: true, workdir: true, baseCommit: true } } },
  });
  return Promise.all(
    runs.map(async (run) => {
      const active = run.agents.filter((agent) => hasBase(agent) && (ACTIVE_AGENT as readonly string[]).includes(agent.status)).at(-1);
      const first = run.agents.find(hasBase);
      let files: string[] = [];
      if (active && first) {
        const dir = workdirPath(active.workdir);
        const knowsFirst = await git(dir, ['cat-file', '-e', `${first.baseCommit}^{commit}`]).then(() => true, () => false);
        files = await changedFiles(active.workdir, knowsFirst ? first.baseCommit! : active.baseCommit!);
      }
      return { task: run.title, files: files.slice(0, MAX_FILES), moreFiles: Math.max(0, files.length - MAX_FILES) };
    }),
  );
}

/** Average cost of the last finished runs of the workflow (API-equivalent USD), to weigh more runs at once. */
async function averageRunCost(workflowId: string) {
  const runs = await prisma.workflowRun.findMany({
    where: { workflowId, status: 'COMPLETED' },
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: { id: true },
  });
  if (runs.length === 0) return null;
  const sum = await prisma.agentUsage.aggregate({ where: { agent: { workflowRunId: { in: runs.map((run) => run.id) } } }, _sum: { costUsd: true } });
  return Math.round(((sum._sum.costUsd ?? 0) / runs.length) * 100) / 100;
}

function prompt(signals: CapacitySignal[], plan: PlanState, details: unknown[]) {
  const percent = (value: number | null) => (value === null ? 'desconhecido' : `${Math.round(value)}%`);
  return `Você está agindo como o Gestor de Capacidade do Studio. Esta conversa foi aberta pelo Studio (não pelo usuário) porque as regras de capacidade mudaram de sinal.

SUA TAREFA
Para cada workflow abaixo, decida se vale mudar "Execuções ao mesmo tempo" (maxConcurrentRuns, de 1 a 5) e, se valer, proponha com studio_propose:
  kind "update_workflow", payload {"id": "<workflowId>", "maxConcurrentRuns": N}, summary "<nome do workflow>: X → N execuções ao mesmo tempo".
Depois explique cada decisão em 1 a 3 frases, em português, para o usuário ler. Não pergunte nada (sem AskUserQuestion): se não valer a pena, diga o motivo em uma frase e não proponha. No máximo uma proposta por workflow. Você só sugere; o usuário aplica no cartão.

COMO DECIDIR
- Subir só ajuda se as tarefas puderem andar em paralelo sem mexer nos mesmos arquivos: cada agente trabalha na própria branch, sem sincronizar com a principal antes do PR, então duas tarefas no mesmo código geram conflito de merge e a execução falha. Compare as tarefas liberadas entre si e com os arquivos que os agentes em execução já tocaram. Se precisar, leia a tarefa inteira com board_get_task.
- Uma tarefa que depende de outra em andamento não fica liberada; não conte com ela.
- Cada execução a mais consome o plano Claude no mesmo ritmo. Use o consumo da janela de 5 h, a semanal e o custo médio por execução para ver se o plano aguenta até a janela reiniciar; os workflows pausam sozinhos em ${plan.limitPercent}%.
- Descer é seguro: proponha quando o plano estiver perto do limite ou quando houve conflito de merge.
- O número sugerido pelas regras é só um ponto de partida (ex.: subir para 2 em vez de 3 se só duas tarefas são independentes).

PLANO CLAUDE
janela de 5 h: ${percent(plan.sessionPercent)} · semanal: ${percent(plan.weekPercent)} · pausa dos workflows em ${plan.limitPercent}%

SINAIS E DADOS
${JSON.stringify(details, null, 2)}`;
}

/** Looks at one workspace; starts an analysis by the agent only when the signals changed. */
async function reviewWorkspace(workspaceId: string, log: FastifyBaseLogger) {
  const hasBoardWorkflow = (await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true }, select: { trigger: true } })).some(
    (workflow) => parseTrigger(workflow).type === 'board_task',
  );
  if (!hasBoardWorkflow) return;

  const [state, plan] = await Promise.all([boardTaskState(workspaceId), planState(workspaceId)]);
  const loads = await workflowLoads(workspaceId, state);
  const signals = capacitySignals(loads, plan);
  const signature = signalsSignature(signals, loads);

  const last = await prisma.capacityReview.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  if ((last?.signature ?? '') === signature) return;

  // Suggestions about a situation that changed are dropped.
  const discardStale = () =>
    prisma.assistantProposal.updateMany({
      where: { workspaceId, status: 'PENDING', agent: { capacityReviews: { some: {} } } },
      data: { status: 'DISCARDED', decidedAt: new Date(), error: 'A situação mudou; o Gestor de Capacidade analisa de novo quando precisar.' },
    });

  if (signals.length === 0) {
    await discardStale();
    await prisma.capacityReview.create({ data: { workspaceId, signature, signals: [] } });
    return;
  }

  const lastAnalysis = await prisma.capacityReview.findFirst({ where: { workspaceId, agentId: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (lastAnalysis && Date.now() - lastAnalysis.createdAt.getTime() < COOLDOWN_MS) return;
  // The analysis is an agent too: not while the plan or Docker are at the limit.
  if (await workspaceBlocker(workspaceId)) return;

  const details = await Promise.all(
    signals.map(async (signal) => {
      const load = loads.find((entry) => entry.workflowId === signal.workflowId)!;
      return {
        workflowId: signal.workflowId,
        workflow: signal.workflowName,
        regra: `${signal.direction === 'up' ? 'subir' : 'descer'} de ${signal.from} para ${signal.to}: ${signal.reason}`,
        execucoesAoMesmoTempo: load.max,
        emExecucao: await runningWork(signal.workflowId),
        tarefasLiberadas: load.readyItems.map((item) => ({ ref: ref(item), titulo: item.title, descricao: item.body.slice(0, MAX_BODY) })),
        tarefasEsperandoDependencias: load.waiting,
        conflitosDeMerge24h: load.recentConflicts,
        custoMedioPorExecucaoUsd: await averageRunCost(signal.workflowId),
      };
    }),
  );

  await discardStale();
  const names = [...new Set(signals.map((signal) => `${signal.workflowName} ${signal.direction === 'up' ? '↑' : '↓'}`))].join(', ');
  const agent = await launchAgent({
    assistantWorkspaceId: workspaceId,
    prompt: prompt(signals, plan, details),
    title: `Gestor de Capacidade: ${names}`.slice(0, 120),
    model: 'sonnet',
    confirmHighUsage: true,
  });
  await prisma.capacityReview.create({
    data: { workspaceId, signature, signals: signals as unknown as Prisma.InputJsonValue, agentId: agent.id },
  });
  log.info({ workspaceId, signals: names }, 'Capacity review started');
}

let reviewing = false;

async function capacityTick(log: FastifyBaseLogger) {
  if (reviewing) return;
  reviewing = true;
  try {
    const workspaces = await prisma.workspace.findMany({ where: { isIgnored: false, missingAt: null, workflows: { some: { isEnabled: true } } }, select: { id: true } });
    for (const { id } of workspaces) {
      await reviewWorkspace(id, log).catch((err) => log.warn({ workspaceId: id, err }, 'Capacity review failed'));
    }
  } finally {
    reviewing = false;
  }
}

/** The Gestor de Capacidade: every few minutes, for every workspace with board workflows. */
export function startCapacityMonitor(log: FastifyBaseLogger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    await capacityTick(log).catch((err) => log.error({ err }, 'Capacity monitor failed'));
    if (!stopped) timer = setTimeout(run, TICK_MS);
  };
  timer = setTimeout(run, 60_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** For the Workflows tab: the pending suggestions and when the last analysis happened. */
export async function capacitySummary(workspaceId: string) {
  const [suggestions, lastAnalysis] = await Promise.all([
    prisma.assistantProposal.findMany({
      where: { workspaceId, status: 'PENDING', agent: { capacityReviews: { some: {} } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.capacityReview.findFirst({ where: { workspaceId, agentId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, agentId: true } }),
  ]);
  return { suggestions, lastAnalysisAt: lastAnalysis?.createdAt ?? null, lastConversationId: lastAnalysis?.agentId ?? null };
}

/** Pending suggestions of every workspace the user sees, for the notice shown on every page. */
export async function pendingCapacitySuggestions(ownerId: string) {
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId, isIgnored: false, ...(await visibleWorkspaceFilter(ownerId)) },
    select: { id: true, name: true },
  });
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const proposals = await prisma.assistantProposal.findMany({
    where: { status: 'PENDING', workspaceId: { in: [...names.keys()] }, agent: { capacityReviews: { some: {} } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, createdAt: true, workspaceId: true },
  });
  return proposals.map((proposal) => ({ ...proposal, workspaceName: names.get(proposal.workspaceId)! }));
}
