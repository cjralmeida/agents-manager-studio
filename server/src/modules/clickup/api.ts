import { HttpError } from '../../lib/errors.js';

const API = 'https://api.clickup.com/api/v2';

type Json = any; // ClickUp responses are narrowed where they are read.

/** Read-only ClickUp API client (personal token); the Studio never changes anything on ClickUp. */
export function createClickupClient(token: string) {
  async function get<T = Json>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`, { headers: { Authorization: token }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!response) throw new HttpError(502, 'Não foi possível conectar ao ClickUp.');
    if (response.status === 401) throw new HttpError(422, 'Token do ClickUp inválido ou sem permissão.');
    const data = (await response.json().catch(() => null)) as Json;
    if (!response.ok) throw new HttpError(502, `ClickUp: ${data?.err ?? `erro ${response.status}`}`);
    return data as T;
  }

  return {
    /** The token's user; also proves the token works. */
    async user() {
      const data = await get('/user');
      return { id: String(data.user.id), username: (data.user.username || data.user.email) as string };
    },

    /** Workspaces (teams), spaces, folders and lists, to find where tasks are. */
    async hierarchy() {
      const { teams } = await get<{ teams: Json[] }>('/team');
      return Promise.all(
        teams.map(async (team) => {
          const { spaces } = await get<{ spaces: Json[] }>(`/team/${team.id}/space?archived=false`);
          return {
            id: team.id,
            name: team.name,
            spaces: await Promise.all(
              spaces.map(async (space) => {
                const [{ folders }, { lists }] = await Promise.all([
                  get<{ folders: Json[] }>(`/space/${space.id}/folder?archived=false`),
                  get<{ lists: Json[] }>(`/space/${space.id}/list?archived=false`),
                ]);
                const asList = (list: Json) => ({ id: list.id, name: list.name, taskCount: list.task_count ?? null });
                return {
                  id: space.id,
                  name: space.name,
                  folders: folders.map((folder) => ({ id: folder.id, name: folder.name, lists: (folder.lists ?? []).map(asList) })),
                  lists: lists.map(asList),
                };
              }),
            ),
          };
        }),
      );
    },

    /** A page of a list's tasks (100 per page), closed and subtasks included. */
    async listTasks(listId: string, page: number) {
      const data = await get<{ tasks: Json[]; last_page?: boolean }>(
        `/list/${encodeURIComponent(listId)}/task?page=${page}&include_closed=true&subtasks=true&order_by=created&reverse=true`,
      );
      return { tasks: data.tasks.map(taskSummary), lastPage: data.last_page ?? data.tasks.length < 100 };
    },

    /** A task with its description (markdown), subtasks, checklists and, optionally, comments. */
    async task(taskId: string, withComments: boolean) {
      const task = await get(`/task/${encodeURIComponent(taskId)}?include_subtasks=true&include_markdown_description=true`);
      const comments = withComments
        ? ((await get<{ comments: Json[] }>(`/task/${encodeURIComponent(taskId)}/comment`)).comments ?? []).map((comment) => ({
            author: comment.user?.username ?? null,
            date: comment.date ? new Date(Number(comment.date)).toISOString() : null,
            text: String(comment.comment_text ?? '').slice(0, 4_000),
          }))
        : undefined;
      return {
        ...taskSummary(task),
        description: String(task.markdown_description ?? task.description ?? '').slice(0, 30_000),
        subtasks: (task.subtasks ?? []).map(taskSummary),
        checklists: (task.checklists ?? []).map((checklist: Json) => ({
          name: checklist.name,
          items: (checklist.items ?? []).map((item: Json) => ({ name: item.name, done: Boolean(item.resolved) })),
        })),
        customFields: (task.custom_fields ?? [])
          .filter((field: Json) => field.value !== undefined && field.value !== null && field.value !== '')
          .map((field: Json) => ({ name: field.name, value: customFieldValue(field) })),
        ...(comments && { comments }),
      };
    },
  };
}

function taskSummary(task: Json) {
  return {
    id: task.id,
    customId: task.custom_id ?? null,
    name: task.name,
    status: task.status?.status ?? null,
    statusType: task.status?.type ?? null,
    parent: task.parent ?? null,
    list: task.list?.name ?? null,
    assignees: (task.assignees ?? []).map((user: Json) => user.username ?? user.email),
    tags: (task.tags ?? []).map((tag: Json) => tag.name),
    priority: task.priority?.priority ?? null,
    dateCreated: task.date_created ? new Date(Number(task.date_created)).toISOString() : null,
    dateDone: task.date_done ? new Date(Number(task.date_done)).toISOString() : null,
    url: task.url ?? null,
  };
}

/** Dropdown and label fields keep option ids in `value`; the names are what an agent can read. */
function customFieldValue(field: Json) {
  const options: Json[] = field.type_config?.options ?? [];
  const name = (id: unknown) => options.find((option) => option.id === id || option.orderindex === id)?.name ?? id;
  if (Array.isArray(field.value)) return field.value.map(name);
  if (options.length > 0) return name(field.value);
  return field.value;
}
