import type { Agent } from '../../api/agents';
import type { BoardItem, BoardLayout } from '../../api/boards';

/** A task of a running workflow run (from /workflow-runs/active-tasks). */
export interface RunTask {
  workspaceId: string;
  taskItemId: string;
  runId: string;
}

/** Waiting for the user beats working, which beats anything else; a cancelled agent is shown last. */
function rank(agent: Agent) {
  if (agent.status === 'WAITING_INPUT') return 3;
  if (['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status)) return 2;
  return agent.status === 'CANCELLED' ? 0 : 1;
}

/**
 * The agent shown on each card, keyed by `key(workspaceId, taskItemId)`. A card gets the agent linked to its task and
 * also the agents of the workflow run working on it (a review, a deploy or a test of several tasks is not linked to
 * one task), so a question from any of them lights the card up. The server lists agents needing the user first.
 */
export function agentsByItem(agents: Agent[], runTasks: RunTask[] = [], key = (_workspaceId: string, taskItemId: string) => taskItemId) {
  const map = new Map<string, Agent>();
  const offer = (mapKey: string, agent: Agent) => {
    const current = map.get(mapKey);
    if (!current || rank(agent) > rank(current)) map.set(mapKey, agent);
  };
  const tasksOfRun = new Map<string, RunTask[]>();
  for (const task of runTasks) tasksOfRun.set(task.runId, [...(tasksOfRun.get(task.runId) ?? []), task]);
  for (const agent of agents) {
    if (agent.taskItemId) offer(key(agent.workspaceId, agent.taskItemId), agent);
    // Only live agents of a run count for its other tasks: a finished step must not cover the current one.
    if (agent.workflowRunId && rank(agent) >= 2) {
      for (const task of tasksOfRun.get(agent.workflowRunId) ?? []) offer(key(task.workspaceId, task.taskItemId), agent);
    }
  }
  return map;
}

export function itemRef(item: BoardItem) {
  if (item.repository && item.number) return `${item.repository.split('/').at(-1)}#${item.number}`;
  return item.isDraft ? 'Rascunho' : '';
}

function priorityRank(board: BoardLayout, item: BoardItem) {
  const field = board.fields.find((entry) => /priori/i.test(entry.name));
  const optionId = field ? item.fields[field.id] : undefined;
  const index = field && optionId ? field.options.findIndex((option) => option.id === optionId) : -1;
  return index === -1 ? 99 : index;
}

/** Tasks whose agent waits for the user first, then by priority, then most recently updated. */
export function sortItems<T extends BoardItem>(board: BoardLayout, items: T[], agents: Map<string, Agent>): T[] {
  const waiting = (item: BoardItem) => (agents.get(item.id)?.status === 'WAITING_INPUT' ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      waiting(a) - waiting(b) ||
      priorityRank(board, a) - priorityRank(board, b) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function matchesSearch(item: BoardItem, search: string) {
  const text = search.trim().toLowerCase();
  if (!text) return true;
  return [item.title, item.repository ?? '', item.number ? `#${item.number}` : '', ...item.assignees]
    .join(' ')
    .toLowerCase()
    .includes(text);
}

/** First message for an agent solving the task; the server adds the board README after it. */
export function agentPromptFor(item: BoardItem) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  return [`Resolva a tarefa ${ref}: ${item.title}`, item.url ?? '', '', item.body.trim()].join('\n').trim();
}
