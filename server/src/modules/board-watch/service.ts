import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { launchAgent } from '../agents/service.js';
import { dependenciesDelivered, dependencyRefs, itemRef } from '../boards/dependencies.js';
import { boardContext } from '../boards/service.js';
import type { BoardItem, StatusMap } from '../boards/types.js';
import { parseSteps, parseTrigger, startBoardRun } from '../workflows/engine.js';
import { runTaskIds, visibleWorkspaceIdsOf } from '../workflows/service.js';
import { stuckReason, type RunSummary } from './rules.js';

/**
 * Board watch: every few minutes (per board, configurable) it looks for tasks left in "Em andamento", "Em validação" or
 * "Em homologação" with no agent working on them, no run going and no reason to wait (dependencies, screens still to
 * be tested, the rest of the feature). Known cases are solved by itself (a run that failed for a passing reason is
 * started again); the others call the workspace's decision agent to sort them out with the user. Everything it finds
 * is listed on the dashboard ("Tarefas paradas").
 */

const TICK_MS = 60_000;
/** A task that changed or whose run ended this recently is not judged yet: the workflows may still be moving it. */
const GRACE_MS = 20 * 60_000;
/** Runs a task may get from the watch in a day before it stops retrying and asks for help. */
const MAX_RETRIES_PER_DAY = 2;
const WATCH_TITLE = 'Destravar';
const ACTIVE = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING'] as const;

const TEST_TRIGGERS = ['feature_in_homologation', 'frontend_in_homologation'];

export interface StuckTask {
  workspaceId: string;
  workspaceName: string;
  itemId: string;
  ref: string | null;
  title: string;
  url: string | null;
  column: string;
  reason: string;
  /** What the watch did about it (or will do on its next round). */
  action: string | null;
  /** The agent called to sort it out, if any. */
  agentId: string | null;
}

interface Found {
  item: BoardItem;
  column: string;
  reason: string;
  lastRun: RunSummary | null;
  retriable: boolean;
}

/** Tasks of a workspace that look stuck, with why. */
async function findStuck(workspaceId: string): Promise<{ found: Found[]; statusMap: StatusMap }> {
  const { snapshot, statusMap } = await boardContext(workspaceId);
  const watched = new Map(
    (['inProgress', 'review', 'homologation'] as const).flatMap((role) => (statusMap[role] ? [[statusMap[role]!, role] as const] : [])),
  );
  const columnName = (id: string | null) => snapshot.columns.find((column) => column.id === id)?.name ?? '?';
  const candidates = snapshot.items.filter((item) => !item.isClosed && item.columnId && watched.has(item.columnId));
  if (candidates.length === 0) return { found: [], statusMap };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const [agents, runs] = await Promise.all([
    prisma.agent.findMany({ where: { workspaceId, status: { in: [...ACTIVE] } }, select: { taskItemId: true, workflowRunId: true } }),
    prisma.workflowRun.findMany({
      where: { workspaceId, OR: [{ status: 'RUNNING' }, { startedAt: { gte: since } }] },
      include: { steps: { orderBy: { startedAt: 'asc' } }, workflow: { select: { name: true, isEnabled: true, trigger: true } } },
      orderBy: { startedAt: 'desc' },
    }),
  ]);
  const busy = new Set<string>();
  for (const agent of agents) if (agent.taskItemId) busy.add(agent.taskItemId);
  const activeRunIds = new Set(agents.map((agent) => agent.workflowRunId).filter(Boolean));
  for (const run of runs) if (run.status === 'RUNNING' || activeRunIds.has(run.id)) for (const id of runTaskIds(run)) busy.add(id);

  const delivered = dependenciesDelivered(snapshot.items, statusMap);
  // Homologation tests that pick tasks from the homologation column: a task waiting for its turn there is not stuck.
  const tests = (await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true }, select: { trigger: true } }))
    .map((workflow) => workflow.trigger as { type?: string; repositories?: string[] })
    .filter((trigger) => trigger.type === 'feature_in_homologation' || trigger.type === 'frontend_in_homologation');
  const isTest = (run: (typeof runs)[number]) => tests.length > 0 && TEST_TRIGGERS.includes((run.workflow.trigger as { type?: string }).type ?? '');
  const testedBy = (item: { repository: string | null }) =>
    tests.some((trigger) => !trigger.repositories?.length || trigger.repositories.some((path) => path.toLowerCase() === (item.repository ?? '').toLowerCase()));
  const found: Found[] = [];
  for (const item of candidates) {
    if (busy.has(item.id)) continue;
    // Waiting for its dependencies is a reason (e.g. a screen whose API is not published yet).
    if (dependencyRefs(item.body).length > 0 && !delivered(item)) continue;
    const lastRun = runs.find((run) => runTaskIds(run).includes(item.id)) ?? null;
    // Delivered to homologation and not tested since: it waits for its turn in the homologation test.
    if (watched.get(item.columnId!) === 'homologation' && testedBy(item) && (!lastRun || !isTest(lastRun))) continue;
    // Work done outside the Studio (someone assigned, no Studio run or agent on it) is theirs to move.
    if (!lastRun && item.assignees.length > 0 && !(await handledByStudio(workspaceId, item.id))) continue;
    const changedAt = Math.max(new Date(item.updatedAt).getTime(), lastRun?.finishedAt?.getTime() ?? 0);
    if (Date.now() - changedAt < GRACE_MS) continue;
    const summary: RunSummary | null = lastRun
      ? {
          id: lastRun.id,
          workflowId: lastRun.workflowId,
          workflowName: lastRun.workflow.name,
          workflowEnabled: lastRun.workflow.isEnabled,
          boardTriggered: parseTrigger(lastRun.workflow).type === 'board_task',
          status: lastRun.status,
          error: [...lastRun.steps].reverse().find((step) => step.status === 'FAILED')?.error ?? lastRun.error,
          runsLastDay: runs.filter((run) => runTaskIds(run).includes(item.id) && run.startedAt > new Date(Date.now() - 24 * 60 * 60_000)).length,
        }
      : null;
    const verdict = stuckReason(columnName(item.columnId), summary, MAX_RETRIES_PER_DAY);
    found.push({ item, column: columnName(item.columnId), reason: verdict.reason, lastRun: summary, retriable: verdict.retriable });
  }
  return { found, statusMap };
}

/** Whether a Studio agent ever worked on the task. */
async function handledByStudio(workspaceId: string, itemId: string) {
  return (await prisma.agent.count({ where: { workspaceId, taskItemId: itemId } })) > 0;
}

/** The decision agent of a workspace (the step of its "task awaiting decision" workflow), to call for help. */
async function decisionProfile(workspaceId: string) {
  const workflows = await prisma.workflow.findMany({ where: { workspaceId, isEnabled: true } });
  const workflow = workflows.find((entry) => parseTrigger(entry).type === 'task_awaiting_decision');
  const step = workflow ? parseSteps(workflow).find((entry) => entry.kind === 'agent') : undefined;
  return step && step.kind === 'agent' ? step.profileId : null;
}

/** The agent the watch called for a task, when it was called after the task's last change. */
async function calledAgent(workspaceId: string, item: BoardItem) {
  const ref = itemRef(item) ?? item.id;
  return prisma.agent.findFirst({
    where: { workspaceId, title: { startsWith: `${WATCH_TITLE}: ${ref}` }, createdAt: { gte: new Date(item.updatedAt) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}

function helpPrompt(found: Found) {
  const { item } = found;
  return [
    `O vigia do quadro achou uma tarefa parada: ${itemRef(item) ?? item.id} — ${item.title} (id no quadro: ${item.id}${item.url ? `, ${item.url}` : ''}).`,
    `Ela está em "${found.column}" sem agente trabalhando, sem execução em andamento e sem motivo para esperar. ${found.reason}`,
    '',
    'Descubra o que a travou (a tarefa, o histórico dela, o PR/MR, o relatório do último passo) e resolva com o usuário: pergunte pela ferramenta AskUserQuestion, com 2 a 4 opções e a recomendada marcada, nunca em texto. Caminhos comuns:',
    '- o trabalho está pronto e só faltou mover: mova para a coluna certa;',
    '- uma falha ficou sem dono (ex.: um teste reprovou algo de outra tarefa): crie a tarefa da correção e ponha nesta a linha "Depende de:";',
    '- precisa ser refeita: escreva o motivo na tarefa e devolva para "A fazer";',
    '- a decisão é do usuário: deixe no Backlog com o campo Decisão = "Aguardando decisão".',
    'Só mova cards depois do sim do usuário. No fim, report_result com o que foi feito.',
    '',
    item.body.trim().slice(0, 6000),
  ].join('\n');
}

/** One round over a workspace: lists what is stuck and acts on it. */
/**
 * Keeps the recurring defects registry in step with the board: a category whose transversal task was delivered (done
 * or closed) is resolved; if that task opens again, the category goes back to "transversal".
 */
async function syncQualityCategories(workspaceId: string, log: FastifyBaseLogger) {
  const categories = await prisma.qualityCategory.findMany({
    where: { workspaceId, status: { in: ['transversal', 'resolvida'] }, transversalRef: { not: null } },
  });
  if (categories.length === 0) return;
  const { snapshot, statusMap } = await boardContext(workspaceId);
  const byRef = new Map(snapshot.items.flatMap((item) => (itemRef(item) ? [[itemRef(item)!.toLowerCase(), item] as const] : [])));
  for (const category of categories) {
    const task = byRef.get(category.transversalRef!.trim().toLowerCase());
    if (!task) continue;
    const delivered = task.isClosed || task.columnId === statusMap.done;
    const status = delivered ? 'resolvida' : 'transversal';
    if (status === category.status) continue;
    await prisma.qualityCategory.update({ where: { id: category.id }, data: { status } });
    log.info({ category: category.name, status }, 'Quality category follows its transversal task');
  }
}

async function watchWorkspace(workspaceId: string, log: FastifyBaseLogger) {
  await syncQualityCategories(workspaceId, log).catch((err: unknown) => log.warn({ workspaceId, err }, 'Quality registry sync failed'));
  const { found } = await findStuck(workspaceId);
  if (found.length === 0) return;
  const profileId = await decisionProfile(workspaceId);
  for (const entry of found) {
    const run = entry.lastRun;
    if (entry.retriable && run) {
      const workflow = await prisma.workflow.findUnique({ where: { id: run.workflowId } });
      if (workflow) {
        await startBoardRun(workflow, entry.item, log);
        log.info({ itemId: entry.item.id, workflow: workflow.name }, 'Board watch started a stuck task again');
        continue;
      }
    }
    if (!profileId || (await calledAgent(workspaceId, entry.item))) continue;
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    const profile = await prisma.agentProfile.findUnique({ where: { id: profileId }, select: { projectIds: true } });
    await launchAgent({
      profileId,
      projectId: profile?.projectIds[0] ?? null,
      prompt: helpPrompt(entry),
      title: `${WATCH_TITLE}: ${itemRef(entry.item) ?? entry.item.id} ${entry.item.title}`.slice(0, 120),
      confirmHighUsage: true,
    }).catch((error: unknown) => log.warn({ itemId: entry.item.id, workspace: workspace.name, err: error }, 'Board watch could not call an agent'));
  }
}

async function tick(log: FastifyBaseLogger) {
  const boards = await prisma.taskBoard.findMany({
    where: { workspace: { isIgnored: false, missingAt: null } },
    select: { id: true, workspaceId: true, watchIntervalMin: true, lastWatchedAt: true },
  });
  const now = Date.now();
  const due = new Map<string, string[]>();
  for (const board of boards) {
    if (board.lastWatchedAt && now - board.lastWatchedAt.getTime() < board.watchIntervalMin * 60_000) continue;
    due.set(board.workspaceId, [...(due.get(board.workspaceId) ?? []), board.id]);
  }
  for (const [workspaceId, boardIds] of due) {
    await prisma.taskBoard.updateMany({ where: { id: { in: boardIds } }, data: { lastWatchedAt: new Date() } });
    await watchWorkspace(workspaceId, log).catch((err: unknown) => log.warn({ workspaceId, err }, 'Board watch failed'));
  }
}

export function startBoardWatch(log: FastifyBaseLogger) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(log)
      .catch((err: unknown) => log.error({ err }, 'Board watch tick failed'))
      .finally(() => (running = false));
  }, TICK_MS);
  return () => clearInterval(timer);
}

/** What is stuck now over the user's visible workspaces, with what the watch did about each one. */
export async function listStuckTasks(userId: string): Promise<StuckTask[]> {
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: await visibleWorkspaceIdsOf(userId) }, taskBoards: { some: {} } },
    select: { id: true, name: true },
  });
  const result: StuckTask[] = [];
  for (const workspace of workspaces) {
    const { found } = await findStuck(workspace.id).catch(() => ({ found: [] as Found[] }));
    const profileId = found.length > 0 ? await decisionProfile(workspace.id) : null;
    for (const entry of found) {
      const agent = await calledAgent(workspace.id, entry.item);
      result.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        itemId: entry.item.id,
        ref: itemRef(entry.item),
        title: entry.item.title,
        url: entry.item.url,
        column: entry.column,
        reason: entry.reason,
        action: entry.retriable
          ? `O vigia vai rodar "${entry.lastRun!.workflowName}" de novo.`
          : agent
            ? 'Um agente foi chamado para resolver com você.'
            : profileId
              ? 'O vigia vai chamar o agente de decisões na próxima verificação.'
              : 'Sem agente de decisões no workspace: resolva à mão.',
        agentId: agent?.id ?? null,
      });
    }
  }
  return result;
}
