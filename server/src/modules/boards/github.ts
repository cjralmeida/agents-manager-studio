import { HttpError } from '../../lib/errors.js';
import type { ParsedBoardUrl } from './board-url.js';
import { BOARD_TEMPLATE, GITHUB_COLORS, type GitHubColor } from './template.js';
import type {
  BoardAdapter,
  BoardCandidate,
  BoardField,
  BoardItem,
  BoardOption,
  BoardSnapshot,
} from './types.js';

/** Max items read from a project (pages of 100). */
const MAX_ITEM_PAGES = 5;

type Json = any; // GraphQL responses are narrowed where they are read.

function graphqlEndpoint(host: string) {
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}

function friendlyError(errors: { type?: string; message?: string }[]) {
  const first = errors[0] ?? {};
  const message = first.message ?? 'erro desconhecido';
  if (first.type === 'INSUFFICIENT_SCOPES' || /not accessible by (personal access|integration)/i.test(message)) {
    return new HttpError(
      422,
      'O token do GitHub não tem acesso a Projects. Dê a permissão "Projects: leitura e escrita" da organização (fine-grained) ou o escopo "project" (classic).',
    );
  }
  if (first.type === 'NOT_FOUND') return new HttpError(404, `GitHub: ${message}`);
  return new HttpError(502, `GitHub: ${message}`);
}

export function createGitHubClient(host: string, token: string) {
  async function gql<T = Json>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(graphqlEndpoint(host), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'agents-manager-studio', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response) throw new HttpError(502, `Não foi possível conectar a ${host}.`);
    if (response.status === 401) throw new HttpError(422, 'Token do GitHub inválido ou expirado.');

    const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: { type?: string; message?: string }[] };
    if (body.errors?.length) throw friendlyError(body.errors);
    if (!body.data) throw new HttpError(502, `GitHub respondeu com erro ${response.status}.`);
    return body.data;
  }

  async function repositoryId(path: string): Promise<string> {
    const [owner, name] = path.split('/');
    const data = await gql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`, {
      owner,
      name,
    });
    if (!data.repository) throw new HttpError(404, `Repositório ${path} não encontrado no GitHub.`);
    return data.repository.id as string;
  }

  async function setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string | null) {
    if (optionId === null) {
      await gql(
        `mutation($p: ID!, $i: ID!, $f: ID!) { clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { clientMutationId } }`,
        { p: projectId, i: itemId, f: fieldId },
      );
      return;
    }
    await gql(
      `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { clientMutationId }
      }`,
      { p: projectId, i: itemId, f: fieldId, o: optionId },
    );
  }

  const adapter: BoardAdapter = {
    async load(board) {
      return loadProject(gql, board.externalId);
    },

    async moveItem(board, snapshot, itemId, columnId) {
      if (!snapshot.statusFieldId) throw new HttpError(422, 'O projeto não tem um campo "Status".');
      await setSingleSelect(board.externalId, itemId, snapshot.statusFieldId, columnId);
    },

    async setItemField(board, _snapshot, itemId, fieldId, optionId) {
      await setSingleSelect(board.externalId, itemId, fieldId, optionId);
    },

    async createTask(board, snapshot, task) {
      let itemId: string;
      if (task.repository) {
        const issue = await gql(
          `mutation($r: ID!, $t: String!, $b: String) { createIssue(input: { repositoryId: $r, title: $t, body: $b }) { issue { id } } }`,
          { r: await repositoryId(task.repository), t: task.title, b: task.body },
        );
        const added = await gql(
          `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
          { p: board.externalId, c: issue.createIssue.issue.id },
        );
        itemId = added.addProjectV2ItemById.item.id;
      } else {
        const draft = await gql(
          `mutation($p: ID!, $t: String!, $b: String) { addProjectV2DraftIssue(input: { projectId: $p, title: $t, body: $b }) { projectItem { id } } }`,
          { p: board.externalId, t: task.title, b: task.body },
        );
        itemId = draft.addProjectV2DraftIssue.projectItem.id;
      }

      if (task.columnId && snapshot.statusFieldId) {
        await setSingleSelect(board.externalId, itemId, snapshot.statusFieldId, task.columnId);
      }
      for (const [fieldId, optionId] of Object.entries(task.fields)) {
        await setSingleSelect(board.externalId, itemId, fieldId, optionId);
      }
      // Read by id: project item listings take a few seconds to include new items.
      const created = await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`, { id: itemId });
      return toItem(created.node, snapshot.statusFieldId ?? undefined);
    },

    async assignSelf(_board, itemId) {
      const data = await gql(
        `query($i: ID!) { viewer { id } node(id: $i) { ... on ProjectV2Item { content { ... on Issue { id } ... on PullRequest { id } } } } }`,
        { i: itemId },
      );
      const contentId = data.node?.content?.id as string | undefined;
      if (!contentId) return;
      await gql(
        `mutation($a: ID!, $u: [ID!]!) { addAssigneesToAssignable(input: { assignableId: $a, assigneeIds: $u }) { clientMutationId } }`,
        { a: contentId, u: [data.viewer.id] },
      );
    },
  };

  return {
    adapter,

    /** Projects linked to the workspace repositories, plus owner projects named like the workspace. */
    async detect(repositories: string[], workspaceName: string): Promise<BoardCandidate[]> {
      const found = new Map<string, BoardCandidate>();
      const add = (nodes: Json[] | undefined) => {
        for (const node of nodes ?? []) {
          if (!node || node.closed || found.has(node.id)) continue;
          found.set(node.id, toCandidate(node));
        }
      };

      for (const path of repositories) {
        const [owner, name] = path.split('/');
        const data = await gql(
          `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { projectsV2(first: 20) { nodes { ${CANDIDATE_FIELDS} } } } }`,
          { owner, name },
        ).catch(() => null);
        add(data?.repository?.projectsV2?.nodes);
      }

      const owners = [...new Set(repositories.map((path) => path.split('/')[0]!))];
      for (const login of owners) {
        const data = await gql(
          `query($login: String!, $q: String!) { repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 20, query: $q) { nodes { ${CANDIDATE_FIELDS} } } } } }`,
          { login, q: workspaceName },
        ).catch(() => null);
        add(data?.repositoryOwner?.projectsV2?.nodes);
      }
      return [...found.values()];
    },

    async resolve(url: Extract<ParsedBoardUrl, { provider: 'GITHUB' }>): Promise<BoardCandidate> {
      const data = await gql(
        `query($login: String!, $n: Int!) { ${url.ownerType}(login: $login) { projectV2(number: $n) { ${CANDIDATE_FIELDS} } } }`,
        { login: url.owner, n: url.number },
      );
      const node = data[url.ownerType]?.projectV2;
      if (!node) throw new HttpError(404, 'Projeto não encontrado ou sem acesso com o token do workspace.');
      return toCandidate(node);
    },

    /** Creates a project by copying the template project, or from the built-in template when there is none. */
    async create(input: { owner: string; title: string; template: BoardCandidate | null; repositories: string[] }) {
      const ownerData = await gql(`query($login: String!) { repositoryOwner(login: $login) { id } }`, { login: input.owner });
      const ownerId = ownerData.repositoryOwner?.id as string | undefined;
      if (!ownerId) throw new HttpError(404, `Organização ou usuário ${input.owner} não encontrado no GitHub.`);

      const projectId = input.template
        ? await copyTemplate(gql, input.template.externalId, ownerId, input.title)
        : await createFromBuiltInTemplate(gql, ownerId, input.title);

      const warnings: string[] = [];
      for (const path of input.repositories) {
        try {
          await gql(
            `mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { clientMutationId } }`,
            { p: projectId, r: await repositoryId(path) },
          );
        } catch (error) {
          warnings.push(`${path}: ${error instanceof Error ? error.message : 'erro'}`);
        }
      }

      const created = await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${CANDIDATE_FIELDS} } } }`, { id: projectId });
      return { candidate: toCandidate(created.node), warnings };
    },
  };
}

const CANDIDATE_FIELDS = `id number title url closed
  owner { ... on Organization { login } ... on User { login } }
  field(name: "Status") { ... on ProjectV2SingleSelectField { options { name } } }`;

function toCandidate(node: Json): BoardCandidate {
  const statusNames = new Set<string>((node.field?.options ?? []).map((option: Json) => option.name));
  const matching = BOARD_TEMPLATE.statuses.filter((status) => statusNames.has(status.name)).length;
  return {
    externalId: node.id,
    ownerPath: node.owner?.login ?? '',
    title: node.title,
    url: node.url,
    matchesTemplate: matching >= 3,
  };
}

type Gql = <T = Json>(query: string, variables?: Record<string, unknown>) => Promise<T>;

async function copyTemplate(gql: Gql, templateId: string, ownerId: string, title: string) {
  const copy = await gql(
    `mutation($p: ID!, $o: ID!, $t: String!) { copyProjectV2(input: { projectId: $p, ownerId: $o, title: $t, includeDraftIssues: false }) { projectV2 { id } } }`,
    { p: templateId, o: ownerId, t: title },
  );
  const projectId = copy.copyProjectV2.projectV2.id as string;

  // The copy keeps fields, views and workflows, but not the README and short description.
  const template = await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 { readme shortDescription } } }`, { id: templateId });
  await gql(
    `mutation($id: ID!, $r: String, $s: String) { updateProjectV2(input: { projectId: $id, readme: $r, shortDescription: $s }) { clientMutationId } }`,
    { id: projectId, r: template.node?.readme ?? null, s: template.node?.shortDescription ?? null },
  );
  return projectId;
}

const toGitHubOptions = (options: { name: string; color: GitHubColor; description: string }[]) =>
  options.map(({ name, color, description }) => ({ name, color, description }));

async function createFromBuiltInTemplate(gql: Gql, ownerId: string, title: string) {
  const created = await gql(`mutation($o: ID!, $t: String!) { createProjectV2(input: { ownerId: $o, title: $t }) { projectV2 { id } } }`, {
    o: ownerId,
    t: title,
  });
  const projectId = created.createProjectV2.projectV2.id as string;

  const status = await gql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id } } } } }`,
    { id: projectId },
  );
  await gql(
    `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { clientMutationId } }`,
    { f: status.node.field.id, o: toGitHubOptions(BOARD_TEMPLATE.statuses) },
  );
  for (const field of BOARD_TEMPLATE.fields) {
    await gql(
      `mutation($p: ID!, $n: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
        createProjectV2Field(input: { projectId: $p, dataType: SINGLE_SELECT, name: $n, singleSelectOptions: $o }) { clientMutationId }
      }`,
      { p: projectId, n: field.name, o: toGitHubOptions(field.options) },
    );
  }
  await gql(
    `mutation($id: ID!, $r: String, $s: String) { updateProjectV2(input: { projectId: $id, readme: $r, shortDescription: $s }) { clientMutationId } }`,
    { id: projectId, r: BOARD_TEMPLATE.readme, s: BOARD_TEMPLATE.shortDescription },
  );
  return projectId;
}

// ---------------------------------------------------------------- load

const ITEM_FIELDS = `id isArchived updatedAt
  fieldValues(first: 30) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } } } }
  content {
    __typename
    ... on DraftIssue { title body }
    ... on Issue {
      number title body url state repository { nameWithOwner }
      assignees(first: 5) { nodes { login } }
      closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { url number state } }
    }
    ... on PullRequest { number title body url state repository { nameWithOwner } assignees(first: 5) { nodes { login } } }
  }`;

function toOption(option: Json): BoardOption {
  return {
    id: option.id,
    name: option.name,
    color: GITHUB_COLORS[option.color as GitHubColor] ?? GITHUB_COLORS.GRAY,
    description: option.description || null,
  };
}

async function loadProject(gql: Gql, projectId: string): Promise<BoardSnapshot> {
  const head = await gql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
      title url readme closed
      fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name color description } } } }
    } } }`,
    { id: projectId },
  );
  const project = head.node;
  if (!project) throw new HttpError(404, 'O projeto vinculado não existe mais ou o token perdeu o acesso.');

  const selects: Json[] = (project.fields.nodes as Json[]).filter((field) => field?.options);
  const status = selects.find((field) => field.name === 'Status');
  const fields: BoardField[] = selects
    .filter((field) => field !== status)
    .map((field) => ({ id: field.id, name: field.name, options: field.options.map(toOption) }));

  const items: BoardItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const data: Json = await gql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } }
      } } }`,
      { id: projectId, after },
    );
    const connection = data.node.items;
    for (const node of connection.nodes as Json[]) {
      if (node && !node.isArchived && node.content) items.push(toItem(node, status?.id));
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return {
    title: project.title,
    url: project.url,
    readme: project.readme || null,
    columns: (status?.options ?? []).map(toOption),
    statusFieldId: status?.id ?? null,
    fields,
    items,
    supportsDrafts: true,
  };
}

function toItem(node: Json, statusFieldId: string | undefined): BoardItem {
  const content = node.content;
  const values: Record<string, string> = {};
  for (const value of node.fieldValues.nodes as Json[]) {
    if (value?.optionId && value.field?.id) values[value.field.id] = value.optionId;
  }
  const columnId = statusFieldId ? (values[statusFieldId] ?? null) : null;
  if (statusFieldId) delete values[statusFieldId];

  const isDraft = content.__typename === 'DraftIssue';
  return {
    id: node.id,
    title: content.title ?? '',
    body: content.body ?? '',
    url: content.url ?? null,
    number: content.number ?? null,
    repository: content.repository?.nameWithOwner ?? null,
    isDraft,
    isClosed: content.state === 'CLOSED' || content.state === 'MERGED',
    columnId,
    fields: values,
    assignees: (content.assignees?.nodes ?? []).map((user: Json) => user.login),
    pullRequests: (content.closedByPullRequestsReferences?.nodes ?? []).map((pr: Json) => ({
      url: pr.url,
      number: pr.number,
      state: pr.state,
    })),
    updatedAt: node.updatedAt,
  };
}
