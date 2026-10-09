import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { GitError, git } from '../../lib/git.js';
import { toContainerPath } from '../../lib/paths.js';
import { secrets } from '../../lib/secrets.js';
import { authenticatedPushUrl, defaultAuthorEmail, parseRemote } from '../agents/remote.js';
import { workspaceNameProblem } from './names.js';
import { scanWorkspaces } from './service.js';

type Provider = 'GITHUB' | 'GITLAB';
type Json = any; // Provider responses are narrowed where they are read.

export interface RepositoryOwner {
  /** Login, organization or group path. */
  path: string;
  kind: 'user' | 'org' | 'group';
  /** GitLab group id (needed to create a project in it). */
  id: number | null;
}

/** Repository name from the folder name: providers only take letters, digits, ".", "_" and "-". */
export function repositorySlug(folder: string) {
  return folder
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function githubApi(host: string) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

function headersFor(provider: Provider, token: string): Record<string, string> {
  return provider === 'GITHUB'
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' }
    : { 'PRIVATE-TOKEN': token };
}

async function providerJson(url: string, init: { headers: Record<string, string>; method?: string; body?: unknown }) {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { ...init.headers, ...(init.body !== undefined && { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  const data: Json = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}

/** Where each git account of the workspace can create repositories: its own user plus organizations/groups. */
export async function listRepositoryOwners(workspaceId: string) {
  const links = await prisma.workspaceGitAccount.findMany({ where: { workspaceId }, include: { gitAccount: true }, orderBy: { gitAccount: { label: 'asc' } } });
  const accounts = [];
  const warnings: string[] = [];
  for (const { gitAccount: account } of links) {
    const provider = account.provider as Provider;
    const owners: RepositoryOwner[] = [{ path: account.username, kind: 'user', id: null }];
    try {
      const headers = headersFor(provider, secrets.decrypt(account.tokenEncrypted));
      if (provider === 'GITHUB') {
        const orgs = await providerJson(`${githubApi(account.host)}/user/orgs?per_page=100`, { headers });
        if (orgs.ok) owners.push(...(orgs.data as Json[]).map((org) => ({ path: String(org.login), kind: 'org' as const, id: null })));
      } else {
        const groups = await providerJson(`https://${account.host}/api/v4/groups?min_access_level=30&per_page=100&order_by=path`, { headers });
        if (groups.ok) {
          owners.push(
            ...(groups.data as Json[])
              // GitLab keeps deleted groups for a while, renamed with "-deletion_scheduled-<id>".
              .filter((group) => !/-deletion_scheduled-\d+/.test(String(group.full_path)))
              .map((group) => ({ path: String(group.full_path), kind: 'group' as const, id: Number(group.id) })),
          );
        }
      }
    } catch (error) {
      warnings.push(`${account.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    accounts.push({ accountId: account.id, label: account.label, provider, host: account.host, owners });
  }
  return { accounts, warnings };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /** Null creates only the local repository. */
  remote: { accountId: string; owner: string; visibility: 'private' | 'public' } | null;
}

interface CreatedRemote {
  cloneUrl: string;
  webUrl: string;
  fullPath: string;
  /** What the provider actually set: GitLab caps it at the group's visibility. */
  visibility: 'private' | 'public';
}

async function createRemote(
  account: { provider: Provider; host: string; username: string; token: string },
  input: { owner: string; ownerId: number | null; name: string; description: string; visibility: 'private' | 'public' },
): Promise<CreatedRemote> {
  const headers = headersFor(account.provider, account.token);
  const where = `${account.host}/${input.owner}`;

  const answer =
    account.provider === 'GITHUB'
      ? await providerJson(
          input.owner.toLowerCase() === account.username.toLowerCase() ? `${githubApi(account.host)}/user/repos` : `${githubApi(account.host)}/orgs/${encodeURIComponent(input.owner)}/repos`,
          { method: 'POST', headers, body: { name: input.name, description: input.description || undefined, private: input.visibility === 'private', auto_init: false } },
        )
      : await providerJson(`https://${account.host}/api/v4/projects`, {
          method: 'POST',
          headers,
          body: {
            name: input.name,
            path: input.name,
            ...(input.ownerId !== null && { namespace_id: input.ownerId }),
            description: input.description || undefined,
            visibility: input.visibility,
            initialize_with_readme: false,
          },
        });

  if (answer.status === 401 || answer.status === 403) {
    const scope = account.provider === 'GITHUB' ? 'escopo "repo" (ou "Administration: write" num token fine-grained)' : 'escopo "api"';
    throw new HttpError(422, `A conta não tem permissão para criar repositórios em ${where}. O token precisa do ${scope}.`);
  }
  const text = JSON.stringify(answer.data ?? '');
  if (answer.status === 422 || (answer.status === 400 && /taken|exist/i.test(text))) {
    throw new HttpError(409, `Já existe um repositório "${input.name}" em ${where}.`);
  }
  if (!answer.ok) throw new HttpError(502, `${account.host} não criou o repositório (erro ${answer.status}).`);

  return account.provider === 'GITHUB'
    ? {
        cloneUrl: String(answer.data.clone_url),
        webUrl: String(answer.data.html_url),
        fullPath: String(answer.data.full_name),
        visibility: answer.data.private ? 'private' : 'public',
      }
    : {
        cloneUrl: String(answer.data.http_url_to_repo),
        webUrl: String(answer.data.web_url),
        fullPath: String(answer.data.path_with_namespace),
        visibility: answer.data.visibility === 'public' ? 'public' : 'private',
      };
}

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

/** Commit author: the chosen account, else any account of the workspace with an author set, else the Studio. */
async function authorFor(
  workspaceId: string,
  account: { provider: string; host: string; username: string; authorName: string | null; authorEmail: string | null } | null,
) {
  const fallback =
    account ??
    (await prisma.workspaceGitAccount.findFirst({ where: { workspaceId, gitAccount: { authorEmail: { not: null } } }, include: { gitAccount: true } }))?.gitAccount ??
    null;
  return {
    name: fallback?.authorName || fallback?.username || 'Agents Manager Studio',
    email: fallback?.authorEmail || (fallback ? defaultAuthorEmail(fallback.provider as Provider, fallback.username, fallback.host) : 'studio@agents-manager.local'),
  };
}

/**
 * Creates a project folder with git (README and a first commit on "main"). With `remote`, first creates the
 * repository on GitHub/GitLab, then links it as "origin" (without credentials) and pushes.
 */
export async function createProject(workspaceId: string, input: CreateProjectInput) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  if (workspace.missingAt) throw new HttpError(409, 'A pasta deste workspace não existe mais.');

  const folder = input.name.trim();
  const problem = workspaceNameProblem(folder, []);
  if (problem) throw new HttpError(422, problem.replace('do workspace', 'do projeto'));
  const dest = toContainerPath(workspace.name, folder);
  if (await exists(dest)) throw new HttpError(409, `Já existe a pasta "${folder}" neste workspace.`);

  let account: { id: string; provider: Provider; host: string; username: string; authorName: string | null; authorEmail: string | null; token: string } | null = null;
  let remote: CreatedRemote | null = null;
  if (input.remote) {
    const link = await prisma.workspaceGitAccount.findFirst({ where: { workspaceId, gitAccountId: input.remote.accountId }, include: { gitAccount: true } });
    if (!link) throw new HttpError(422, 'Essa conta git não está ativa neste workspace.');
    const { gitAccount } = link;
    account = { ...gitAccount, provider: gitAccount.provider as Provider, token: secrets.decrypt(gitAccount.tokenEncrypted) };

    const owners = (await listRepositoryOwners(workspaceId)).accounts.find((entry) => entry.accountId === gitAccount.id)?.owners ?? [];
    const owner = owners.find((entry) => entry.path.toLowerCase() === input.remote!.owner.toLowerCase());
    if (!owner) throw new HttpError(422, `A conta ${gitAccount.label} não pode criar repositórios em "${input.remote.owner}".`);
    const name = repositorySlug(folder);
    if (!name) throw new HttpError(422, 'Use letras ou números no nome para formar o nome do repositório.');
    remote = await createRemote(account, { owner: owner.path, ownerId: owner.id, name, description: input.description?.trim() ?? '', visibility: input.remote.visibility });
  }

  const token = account?.token ?? null;
  const redact = (text: string) => (token ? text.replaceAll(token, '***').replaceAll(encodeURIComponent(token), '***') : text);
  try {
    await mkdir(dest);
    const description = input.description?.trim();
    await writeFile(path.join(dest, 'README.md'), `# ${folder}\n${description ? `\n${description}\n` : ''}`, 'utf8');
    const author = await authorFor(workspaceId, account);
    await git(dest, ['init', '-q', '-b', 'main']);
    await git(dest, ['add', 'README.md']);
    await git(dest, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', 'Initial commit']);

    if (remote && account) {
      const parsed = parseRemote(remote.cloneUrl);
      if (!parsed) throw new Error(`URL do repositório não reconhecida: ${remote.cloneUrl}`);
      await git(dest, ['remote', 'add', 'origin', remote.cloneUrl]);
      // The token goes only in this push; "origin" keeps the URL without credentials.
      await git(dest, ['push', '-q', authenticatedPushUrl(parsed, account.provider, account.token), 'main:main'], { timeoutMs: 120_000 });
      await git(dest, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await git(dest, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    }
  } catch (error) {
    // The folder was created here, so a failure removes it; the remote repository is kept (never deleted by the Studio).
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    const raw = error instanceof GitError ? error.stderr || error.message : error instanceof Error ? error.message : String(error);
    const message = redact(raw).trim().split('\n').slice(-2).join(' ');
    const created = remote ? ` O repositório ${remote.webUrl} já foi criado; apague-o lá ou clone-o pelo Studio.` : '';
    throw new HttpError(500, `Não foi possível preparar o projeto: ${message}.${created}`);
  }

  await scanWorkspaces();
  const project = await prisma.project.findFirst({ where: { workspaceId, name: folder } });
  return { projectId: project?.id ?? null, folder, remoteUrl: remote?.webUrl ?? null, remotePath: remote?.fullPath ?? null, remoteVisibility: remote?.visibility ?? null };
}
