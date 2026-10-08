import { HttpError } from '../../lib/errors.js';
import type { ParsedBoardUrl } from './board-url.js';
import { BOARD_TEMPLATE, GITHUB_COLORS, GITLAB_STATUS_PREFIX } from './template.js';
import type { BoardAdapter, BoardCandidate, BoardField, BoardItem, BoardOption, BoardSnapshot } from './types.js';

/**
 * GitLab (Free) has no single-select fields, so a board is a group issue board whose lists are labels:
 * - columns: "open" (issues without a list label), one per list label, and "closed";
 * - fields: labels named "Prefix: value" (e.g. "Prioridade: P1 - Alta"), one field per prefix.
 */

const OPEN_COLUMN = 'open';
const CLOSED_COLUMN = 'closed';
const MAX_OPEN_PAGES = 5;
/** Closed issues are shown only when updated recently, so "Concluído" does not grow forever. */
const CLOSED_WINDOW_DAYS = 30;

type Json = any; // REST responses are narrowed where they are read.

interface GitLabLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface GitLabBoard {
  id: number;
  name: string;
  lists: { id: number; position: number; label: GitLabLabel | null }[];
}

const columnId = (label: GitLabLabel) => `label:${label.id}`;
const fieldId = (prefix: string) => `prefix:${prefix}`;
const itemId = (projectId: number, iid: number) => `${projectId}:${iid}`;

function parseItemId(id: string) {
  const [projectId, iid] = id.split(':').map(Number);
  if (!projectId || !iid) throw new HttpError(400, 'Item do quadro inválido.');
  return { projectId, iid };
}

function parseExternalId(externalId: string) {
  const [groupId, boardId] = externalId.split(':').map(Number);
  return { groupId: groupId!, boardId: boardId! };
}

function splitPrefixed(name: string) {
  const index = name.indexOf(': ');
  return index > 0 ? { prefix: name.slice(0, index), value: name.slice(index + 2) } : null;
}

function displayName(label: GitLabLabel) {
  return label.name.startsWith(GITLAB_STATUS_PREFIX) ? label.name.slice(GITLAB_STATUS_PREFIX.length) : label.name;
}

function boardUrl(host: string, groupPath: string, boardId: number) {
  return `https://${host}/groups/${groupPath}/-/boards/${boardId}`;
}

export function createGitLabClient(host: string, token: string) {
  const base = `https://${host}/api/v4`;

  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response) throw new HttpError(502, `Não foi possível conectar a ${host}.`);
    if (response.status === 401) throw new HttpError(422, 'Token do GitLab inválido ou expirado.');
    return { status: response.status, body: (await response.json().catch(() => null)) as T };
  }

  async function request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await call<T>(method, path, body);
    if (result.status >= 400) {
      const message = (result.body as Json)?.message ?? (result.body as Json)?.error ?? `erro ${result.status}`;
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      throw new HttpError(result.status === 404 ? 404 : result.status === 403 ? 422 : 502, `GitLab: ${text}`);
    }
    return result.body;
  }

  async function groupLabels(groupId: number): Promise<GitLabLabel[]> {
    const labels: GitLabLabel[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await request<GitLabLabel[]>('GET', `/groups/${groupId}/labels?per_page=100&page=${page}&include_ancestor_groups=true`);
      labels.push(...batch);
      if (batch.length < 100) break;
    }
    return labels;
  }

  async function issuesOf(groupId: number): Promise<Json[]> {
    const issues: Json[] = [];
    for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
      const batch = await request<Json[]>('GET', `/groups/${groupId}/issues?state=opened&per_page=100&page=${page}`);
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    const since = new Date(Date.now() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString();
    issues.push(...(await request<Json[]>('GET', `/groups/${groupId}/issues?state=closed&updated_after=${since}&per_page=100`)));
    return issues;
  }

  async function updateIssue(id: string, data: Record<string, unknown>) {
    const { projectId, iid } = parseItemId(id);
    await request('PUT', `/projects/${projectId}/issues/${iid}`, data);
  }

  function statusChange(snapshot: BoardSnapshot, item: BoardItem | undefined, target: string) {
    const listLabels = snapshot.columns.filter((column) => column.id.startsWith('label:')).map((column) => labelName(snapshot, column.id));
    const add = target.startsWith('label:') ? [labelName(snapshot, target)] : [];
    const data: Record<string, unknown> = {
      remove_labels: listLabels.filter((name) => !add.includes(name)).join(','),
      add_labels: add.join(','),
    };
    if (target === CLOSED_COLUMN && !item?.isClosed) data.state_event = 'close';
    if (target !== CLOSED_COLUMN && item?.isClosed) data.state_event = 'reopen';
    return data;
  }

  const adapter: BoardAdapter = {
    async load(board) {
      const { groupId, boardId } = parseExternalId(board.externalId);
      const [detail, labels, issues] = await Promise.all([
        request<GitLabBoard>('GET', `/groups/${groupId}/boards/${boardId}`),
        groupLabels(groupId),
        issuesOf(groupId),
      ]);

      const lists = [...detail.lists].sort((a, b) => a.position - b.position).filter((list) => list.label);
      const listLabelIds = new Set(lists.map((list) => list.label!.id));
      const columns: BoardOption[] = [
        { id: OPEN_COLUMN, name: 'A fazer', color: GITHUB_COLORS.GRAY, description: 'Issues abertas sem coluna.' },
        ...lists.map((list) => ({
          id: columnId(list.label!),
          name: displayName(list.label!),
          color: list.label!.color,
          description: list.label!.description,
          // Kept to find the label name when moving items.
          labelName: list.label!.name,
        })),
        { id: CLOSED_COLUMN, name: 'Concluído', color: GITHUB_COLORS.GREEN, description: 'Issues fechadas.' },
      ];

      const fieldsByPrefix = new Map<string, BoardField>();
      for (const label of labels) {
        const parts = splitPrefixed(label.name);
        if (!parts || listLabelIds.has(label.id) || label.name.startsWith(GITLAB_STATUS_PREFIX)) continue;
        const field = fieldsByPrefix.get(parts.prefix) ?? { id: fieldId(parts.prefix), name: parts.prefix, options: [] };
        if (!field.options.some((option) => option.name === parts.value)) {
          field.options.push({ id: String(label.id), name: parts.value, color: label.color, description: label.description });
        }
        fieldsByPrefix.set(parts.prefix, field);
      }
      const fields = sortLikeTemplate([...fieldsByPrefix.values()]);

      const items = issues.map((issue) => issueToItem(issue, columns, fields));

      return {
        title: detail.name,
        url: boardUrl(host, board.ownerPath, boardId),
        readme: board.readme,
        columns,
        statusFieldId: null,
        fields,
        items,
        supportsDrafts: false,
      };
    },

    async moveItem(_board, snapshot, id, target) {
      const item = snapshot.items.find((entry) => entry.id === id);
      await updateIssue(id, statusChange(snapshot, item, target));
    },

    async setItemField(_board, snapshot, id, field, optionId) {
      const definition = snapshot.fields.find((entry) => entry.id === field);
      if (!definition) throw new HttpError(404, 'Campo não encontrado no quadro.');
      const full = (name: string) => `${definition.name}: ${name}`;
      const chosen = definition.options.find((option) => option.id === optionId);
      await updateIssue(id, {
        remove_labels: definition.options.filter((option) => option !== chosen).map((option) => full(option.name)).join(','),
        add_labels: chosen ? full(chosen.name) : '',
      });
    },

    async createTask(_board, snapshot, task) {
      if (!task.repository) throw new HttpError(422, 'No GitLab, toda tarefa precisa de um projeto.');
      const labels: string[] = [];
      if (task.columnId?.startsWith('label:')) labels.push(labelName(snapshot, task.columnId));
      for (const [field, optionId] of Object.entries(task.fields)) {
        const definition = snapshot.fields.find((entry) => entry.id === field);
        const option = definition?.options.find((entry) => entry.id === optionId);
        if (definition && option) labels.push(`${definition.name}: ${option.name}`);
      }
      const issue = await request<Json>('POST', `/projects/${encodeURIComponent(task.repository)}/issues`, {
        title: task.title,
        description: task.body,
        labels: labels.join(','),
      });
      const id = itemId(issue.project_id, issue.iid);
      if (task.columnId === CLOSED_COLUMN) {
        await updateIssue(id, { state_event: 'close' });
        issue.state = 'closed';
      }
      return issueToItem(issue, snapshot.columns, snapshot.fields);
    },

    async assignSelf(_board, id) {
      const user = await request<{ id: number }>('GET', '/user');
      await updateIssue(id, { assignee_ids: [user.id] });
    },
  };

  async function groupByPath(path: string) {
    return request<{ id: number; full_path: string }>('GET', `/groups/${encodeURIComponent(path)}`);
  }

  /**
   * The REST endpoint for group boards is a paid feature (403 on Free), but the GraphQL mutation
   * still creates the group's first board. When neither works, an existing board of the group is reused.
   */
  async function createOrReuseBoard(group: { id: number; full_path: string }, title: string) {
    const created = await call<GitLabBoard>('POST', `/groups/${group.id}/boards`, { name: title });
    if (created.status === 201) return created.body;
    if (created.status !== 403) throw new HttpError(502, `GitLab recusou a criação do board (erro ${created.status}).`);

    const viaGraphql = await createBoardWithGraphql(group.full_path, title);
    if (viaGraphql) return request<GitLabBoard>('GET', `/groups/${group.id}/boards/${viaGraphql}`);

    const boards = await request<GitLabBoard[]>('GET', `/groups/${group.id}/boards`);
    if (boards[0]) return boards[0];
    throw new HttpError(422, 'O GitLab não permitiu criar um board neste grupo. Crie um board pelo site e vincule pela URL.');
  }

  /** Returns the new board id, or null when GitLab refuses. */
  async function createBoardWithGraphql(groupPath: string, title: string): Promise<number | null> {
    const response = await fetch(`https://${host}/api/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation($path: ID!, $name: String!) { createBoard(input: { groupPath: $path, name: $name }) { board { id } errors } }`,
        variables: { path: groupPath, name: title },
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as Json;
    const id = body?.data?.createBoard?.board?.id as string | undefined;
    return id ? Number(id.split('/').pop()) : null;
  }

  function toCandidate(group: { id: number; full_path: string }, board: GitLabBoard): BoardCandidate {
    const statusLists = board.lists.filter((list) => list.label?.name.startsWith(GITLAB_STATUS_PREFIX)).length;
    return {
      externalId: `${group.id}:${board.id}`,
      ownerPath: group.full_path,
      title: `${board.name} (${group.full_path})`,
      url: boardUrl(host, group.full_path, board.id),
      matchesTemplate: statusLists >= 2,
    };
  }

  return {
    adapter,

    /** Boards of the groups that hold the workspace projects (and their parent groups). */
    async detect(repositories: string[]): Promise<BoardCandidate[]> {
      const groups = new Set<string>();
      for (const path of repositories) {
        const parts = path.split('/').slice(0, -1);
        for (let size = parts.length; size > 0; size--) groups.add(parts.slice(0, size).join('/'));
      }

      const candidates: BoardCandidate[] = [];
      for (const path of groups) {
        const group = await groupByPath(path).catch(() => null);
        if (!group) continue;
        const boards = await request<GitLabBoard[]>('GET', `/groups/${group.id}/boards`).catch(() => []);
        candidates.push(...boards.map((board) => toCandidate(group, board)));
      }
      return candidates;
    },

    async resolve(url: Extract<ParsedBoardUrl, { provider: 'GITLAB' }>): Promise<BoardCandidate> {
      const group = await groupByPath(url.groupPath);
      if (url.boardId) return toCandidate(group, await request<GitLabBoard>('GET', `/groups/${group.id}/boards/${url.boardId}`));
      const boards = await request<GitLabBoard[]>('GET', `/groups/${group.id}/boards`);
      if (!boards[0]) throw new HttpError(404, 'O grupo não tem nenhum board.');
      return toCandidate(group, boards[0]);
    },

    /** Creates the template labels in the group, then a board with one list per status label. */
    async create(input: { groupPath: string; title: string }) {
      const group = await groupByPath(input.groupPath);

      const wanted = [
        ...BOARD_TEMPLATE.statuses
          .filter((status) => status.role !== 'todo' && status.role !== 'done')
          .map((status) => ({ ...status, name: `${GITLAB_STATUS_PREFIX}${status.name}` })),
        ...BOARD_TEMPLATE.fields.flatMap((field) => field.options.map((option) => ({ ...option, name: `${field.name}: ${option.name}` }))),
      ];
      const existing = new Map((await groupLabels(group.id)).map((label) => [label.name, label]));
      for (const label of wanted) {
        if (existing.has(label.name)) continue;
        const created = await request<GitLabLabel>('POST', `/groups/${group.id}/labels`, {
          name: label.name,
          color: GITHUB_COLORS[label.color],
          description: label.description,
        });
        existing.set(created.name, created);
      }

      const board = await createOrReuseBoard(group, input.title);
      const listed = new Set(board.lists.map((list) => list.label?.id));
      const statusLabels = wanted.filter((label) => label.name.startsWith(GITLAB_STATUS_PREFIX));
      for (const label of statusLabels) {
        const labelId = existing.get(label.name)!.id;
        if (!listed.has(labelId)) await request('POST', `/groups/${group.id}/boards/${board.id}/lists`, { label_id: labelId });
      }

      const created = await request<GitLabBoard>('GET', `/groups/${group.id}/boards/${board.id}`);
      return { candidate: toCandidate(group, created), readme: BOARD_TEMPLATE.readme };
    },
  };
}

/** GitLab lists labels alphabetically; fields and options known from the template keep the template order. */
function sortLikeTemplate(fields: BoardField[]) {
  const rank = <T>(list: T[], found: T | undefined) => (found === undefined ? list.length : list.indexOf(found));
  const templateField = (field: BoardField) => BOARD_TEMPLATE.fields.find((entry) => entry.name === field.name);
  for (const field of fields) {
    const options = templateField(field)?.options ?? [];
    const position = (option: BoardOption) => rank(options, options.find((entry) => entry.name === option.name));
    field.options.sort((a, b) => position(a) - position(b));
  }
  const fieldPosition = (field: BoardField) => rank(BOARD_TEMPLATE.fields, templateField(field));
  return fields.sort((a, b) => fieldPosition(a) - fieldPosition(b));
}

/** Column = list label present on the issue (open), or "closed"; fields = "Prefix: value" labels. */
function issueToItem(issue: Json, columns: BoardOption[], fields: BoardField[]): BoardItem {
  const names = new Set<string>(issue.labels ?? []);
  const list = columns.find((column) => {
    const name = (column as BoardOption & { labelName?: string }).labelName;
    return name !== undefined && names.has(name);
  });
  const values: Record<string, string> = {};
  for (const field of fields) {
    const option = field.options.find((entry) => names.has(`${field.name}: ${entry.name}`));
    if (option) values[field.id] = option.id;
  }
  return {
    id: itemId(issue.project_id, issue.iid),
    title: issue.title,
    body: issue.description ?? '',
    url: issue.web_url,
    number: issue.iid,
    repository: String(issue.references?.full ?? '').split('#')[0] || null,
    isDraft: false,
    isClosed: issue.state === 'closed',
    columnId: issue.state === 'closed' ? CLOSED_COLUMN : (list?.id ?? OPEN_COLUMN),
    fields: values,
    assignees: (issue.assignees ?? []).map((user: Json) => user.username),
    pullRequests: [],
    updatedAt: issue.updated_at,
  };
}

function labelName(snapshot: BoardSnapshot, column: string) {
  const entry = snapshot.columns.find((option) => option.id === column) as (BoardOption & { labelName?: string }) | undefined;
  if (!entry?.labelName) throw new HttpError(404, 'Coluna não encontrada no quadro.');
  return entry.labelName;
}
