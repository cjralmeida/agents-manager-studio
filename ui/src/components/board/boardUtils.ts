import { type Agent, isWorking } from '../../api/agents';
import type { BoardItem, BoardLayout, StatusMap } from '../../api/boards';

/** A task of a running workflow run (from /workflow-runs/active-tasks). */
export interface RunTask {
  workspaceId: string;
  taskItemId: string;
  runId: string;
}

/** Waiting for the user beats working, which beats anything else; a cancelled agent is shown last. */
function rank(agent: Agent) {
  if (agent.status === 'WAITING_INPUT') return 3;
  if (isWorking(agent)) return 2;
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

/**
 * A task that came back with a test report (homologation or play test) and is not done: a fix, picked before new work.
 * Returns 'HOM' | 'teste' | null.
 */
export function reworkOrigin(item: BoardItem, statusMap: StatusMap): 'HOM' | 'teste' | null {
  if (item.isClosed || (statusMap.done && item.columnId === statusMap.done)) return null;
  const match = /^#{2,3}\s*Relatório de (HOM|teste)\b/im.exec(item.body);
  return match ? (match[1] === 'HOM' ? 'HOM' : 'teste') : null;
}

export interface DependencyLink {
  /** The reference exactly as written in the body (e.g. "globalfarm#231" or "#231"). */
  raw: string;
  /** The board task it points to, when it could be resolved. */
  item?: BoardItem;
}

const DEP_LINE = /^\s*(?:[-*]\s*)?\**\s*depende de\s*\**\s*:?\**\s*(.+?)\s*$/i;

/** References listed on "Depende de:" lines of a task body (split on commas, semicolons and " e "). */
export function parseDependsOn(body: string): string[] {
  const refs: string[] = [];
  for (const line of body.split('\n')) {
    const m = DEP_LINE.exec(line);
    if (!m) continue;
    for (const part of (m[1] ?? '').split(/[,;]|\s+e\s+/i)) {
      const ref = part.trim().replace(/[.)\]]+$/, '').trim();
      if (/#\d+/.test(ref)) refs.push(ref);
    }
  }
  return refs;
}

/** Resolve a "repo#123" / "#123" reference to a board task, matching by number and (when given) repository path. */
function resolveRef(ref: string, from: BoardItem, all: BoardItem[]): BoardItem | undefined {
  const m = /#(\d+)/.exec(ref);
  if (!m) return undefined;
  const number = Number(m[1]);
  const path = ref.slice(0, m.index).trim().replace(/[#@]+$/, '').trim().toLowerCase();
  const sameNumber = all.filter((i) => i.number === number);
  if (!path) return sameNumber.find((i) => i.repository === from.repository) ?? (sameNumber.length === 1 ? sameNumber[0] : undefined);
  const tail = path.split('/').at(-1);
  return (
    sameNumber.find((i) => i.repository?.toLowerCase() === path) ??
    sameNumber.find((i) => i.repository?.toLowerCase().endsWith(`/${tail}`)) ??
    sameNumber.find((i) => i.repository?.split('/').at(-1)?.toLowerCase() === tail) ??
    (sameNumber.length === 1 ? sameNumber[0] : undefined)
  );
}

export interface ChecklistItem {
  /** Stable storage key: the CA code (e.g. "CA-14"), or "DOD:<hash>" for a Definition-of-Done line. */
  key: string;
  /** CA code to show as a chip, when the line has one. */
  code: string | null;
  label: string;
  kind: 'CA' | 'DOD';
}

export interface ChecklistSection {
  kind: 'CA' | 'DOD';
  title: string;
  items: ChecklistItem[];
}

const CA_AT_START = /^\s*(?:\[[ xX]\]\s*)?\*{0,2}\s*(CA-\d+(?:\.\d+)?)\b/;
const DOD_META = /^(documento|relacionad|os dados|fonte|refer[eê]ncia|obs\b|nota\b)/i;

function hash8(text: string): string {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(0, 8);
}

/** The readable part of a criterion line: the sentence after the em dash, with markdown and the code stripped. */
function cleanLabel(raw: string): string {
  let text = raw.replace(/^\[[ xX]\]\s*/, '');
  const dash = text.indexOf('—');
  if (dash >= 0) text = text.slice(dash + 1);
  return text
    .replace(/\*\*/g, '')
    .replace(/^\s*[-:]\s*/, '')
    .trim();
}

/**
 * Checklists parsed from a task body: acceptance criteria ("### Critérios de aceite", one line per CA code) and
 * the Definition of Done ("### Critério de conclusão"). CA lines key by their CA code (stable, and what an agent can
 * tick); DoD lines key by a hash of their text. Meta bullets (Documento, Relacionada…) are left out.
 */
export function parseChecklist(body: string): ChecklistSection[] {
  const caItems: ChecklistItem[] = [];
  const dodItems: ChecklistItem[] = [];
  let current: 'CA' | 'DOD' | null = null;
  for (const line of body.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const title = heading[1] ?? '';
      if (/crit[eé]rios?\s+de\s+aceit/i.test(title)) current = 'CA';
      else if (/crit[eé]rio\s+de\s+conclus/i.test(title) || /defini[cç][aã]o\s+de\s+(conclus|pronto|done)/i.test(title) || /\bDoD\b/i.test(title))
        current = 'DOD';
      else current = null;
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const raw = (bullet[1] ?? '').trim();
    if (current === 'CA') {
      const match = CA_AT_START.exec(raw);
      if (!match) continue;
      const code = match[1] ?? '';
      if (caItems.some((entry) => entry.key === code)) continue;
      caItems.push({ key: code, code, label: cleanLabel(raw), kind: 'CA' });
    } else {
      const bare = raw.replace(/^\[[ xX]\]\s*/, '').replace(/^\*{0,2}\s*/, '');
      if (DOD_META.test(bare)) continue;
      const label = cleanLabel(raw);
      if (!label) continue;
      const key = `DOD:${hash8(label.toLowerCase().replace(/\s+/g, ' '))}`;
      if (dodItems.some((entry) => entry.key === key)) continue;
      dodItems.push({ key, code: CA_AT_START.exec(raw)?.[1] ?? null, label, kind: 'DOD' });
    }
  }
  const sections: ChecklistSection[] = [];
  if (caItems.length) sections.push({ kind: 'CA', title: 'Critérios de aceite', items: caItems });
  if (dodItems.length) sections.push({ kind: 'DOD', title: 'Critério de conclusão (DoD)', items: dodItems });
  return sections;
}

/** What a task waits on ("Depende de:") and what it blocks (other tasks that depend on it). */
export function taskRelations(item: BoardItem, all: BoardItem[]): { dependsOn: DependencyLink[]; blocks: BoardItem[] } {
  const dependsOn = parseDependsOn(item.body).map((raw) => ({ raw, item: resolveRef(raw, item, all) }));
  const blocks = all.filter(
    (other) => other.id !== item.id && parseDependsOn(other.body).some((raw) => resolveRef(raw, other, all)?.id === item.id),
  );
  return { dependsOn, blocks };
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
