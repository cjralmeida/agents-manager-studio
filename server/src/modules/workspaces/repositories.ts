import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';

export interface AccountRepository {
  provider: 'GITHUB' | 'GITLAB';
  host: string;
  account: string;
  /** owner/repo or group/sub/repo */
  fullName: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  description: string | null;
  updatedAt: string | null;
}

type Json = any; // Provider responses are narrowed where they are read.

async function getJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  if (response.status === 401 || response.status === 403) throw new HttpError(422, `Token sem permissão para listar repositórios em ${new URL(url).host}.`);
  if (!response.ok) throw new HttpError(502, `${new URL(url).host} respondeu com erro ${response.status}.`);
  return (await response.json()) as Json;
}

async function githubRepos(host: string, token: string, search: string) {
  const api = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' };
  // Recently updated repositories the account can reach (own, collaborator and organization).
  const rows: Json[] = await getJson(`${api}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`, headers);
  const term = search.toLowerCase();
  return rows
    .filter((repo) => !term || String(repo.full_name).toLowerCase().includes(term))
    .map((repo) => ({
      fullName: repo.full_name as string,
      name: repo.name as string,
      cloneUrl: repo.clone_url as string,
      defaultBranch: (repo.default_branch as string) ?? null,
      isPrivate: Boolean(repo.private),
      description: (repo.description as string) ?? null,
      updatedAt: (repo.pushed_at as string) ?? null,
    }));
}

async function gitlabRepos(host: string, token: string, search: string) {
  const query = new URLSearchParams({ membership: 'true', simple: 'true', order_by: 'last_activity_at', per_page: '100' });
  if (search) query.set('search', search);
  const rows: Json[] = await getJson(`https://${host}/api/v4/projects?${query}`, { 'PRIVATE-TOKEN': token });
  // GitLab keeps projects of deleted groups for a while, renamed with "-deletion_scheduled-<id>".
  return rows.filter((project) => !/-deletion_scheduled-\d+/.test(String(project.path_with_namespace))).map((project) => ({
    fullName: project.path_with_namespace as string,
    name: project.path as string,
    cloneUrl: project.http_url_to_repo as string,
    defaultBranch: (project.default_branch as string) ?? null,
    isPrivate: project.visibility !== 'public',
    description: (project.description as string) || null,
    updatedAt: (project.last_activity_at as string) ?? null,
  }));
}

/** Repositories the git accounts of the workspace can reach, to clone without typing the URL. */
export async function listAccountRepositories(workspaceId: string, search = '') {
  const links = await prisma.workspaceGitAccount.findMany({ where: { workspaceId }, include: { gitAccount: true } });
  if (links.length === 0) throw new HttpError(422, 'Vincule uma conta git (GitHub ou GitLab) na Configuração do workspace para listar repositórios.');

  const repositories: AccountRepository[] = [];
  const warnings: string[] = [];
  for (const { gitAccount: account } of links) {
    try {
      const token = secrets.decrypt(account.tokenEncrypted);
      const provider = account.provider as 'GITHUB' | 'GITLAB';
      const rows = provider === 'GITHUB' ? await githubRepos(account.host, token, search.trim()) : await gitlabRepos(account.host, token, search.trim());
      repositories.push(...rows.map((row) => ({ ...row, provider, host: account.host, account: account.label })));
    } catch (error) {
      warnings.push(`${account.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  repositories.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return { repositories, warnings };
}
