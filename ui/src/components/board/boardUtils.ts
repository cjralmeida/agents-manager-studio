import type { Agent } from '../../api/agents';
import type { Board, BoardItem } from '../../api/boards';

/** The agent shown on a card: the first non-cancelled one (the server lists agents needing the user first). */
export function agentsByItem(agents: Agent[]) {
  const map = new Map<string, Agent>();
  for (const agent of agents) {
    if (!agent.taskItemId) continue;
    const current = map.get(agent.taskItemId);
    if (!current || (current.status === 'CANCELLED' && agent.status !== 'CANCELLED')) map.set(agent.taskItemId, agent);
  }
  return map;
}

export function itemRef(item: BoardItem) {
  if (item.repository && item.number) return `${item.repository.split('/').at(-1)}#${item.number}`;
  return item.isDraft ? 'Rascunho' : '';
}

function priorityRank(board: Board, item: BoardItem) {
  const field = board.fields.find((entry) => /priori/i.test(entry.name));
  const optionId = field ? item.fields[field.id] : undefined;
  const index = field && optionId ? field.options.findIndex((option) => option.id === optionId) : -1;
  return index === -1 ? 99 : index;
}

/** Tasks whose agent waits for the user first, then by priority, then most recently updated. */
export function sortItems(board: Board, items: BoardItem[], agents: Map<string, Agent>) {
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
