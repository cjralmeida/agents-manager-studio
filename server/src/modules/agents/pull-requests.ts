import { HttpError } from '../../lib/errors.js';
import type { RemoteInfo } from './remote.js';

export interface PullRequestInput {
  provider: 'GITHUB' | 'GITLAB';
  remote: RemoteInfo;
  token: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

async function api<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

/** Opens a PR (GitHub) or MR (GitLab); when one already exists for the branch, returns its url. */
export function openPullRequest(input: PullRequestInput): Promise<string> {
  return input.provider === 'GITHUB' ? openGitHubPullRequest(input) : openGitLabMergeRequest(input);
}

async function openGitHubPullRequest(input: PullRequestInput) {
  const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
  const [owner, repo] = input.remote.path.split('/');
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agents-manager-studio',
    'Content-Type': 'application/json',
  };

  type Pull = { html_url?: string; message?: string; errors?: { message?: string }[] };
  const created = await api<Pull>(`${apiBase}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: input.title, head: input.branch, base: input.baseBranch, body: input.body }),
  });
  if (created.status === 201 && created.body.html_url) return created.body.html_url;

  if (created.status === 422) {
    const existing = await api<Pull[]>(
      `${apiBase}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.branch}`)}&state=open`,
      { headers },
    );
    const url = Array.isArray(existing.body) ? existing.body[0]?.html_url : undefined;
    if (url) return url;
  }

  const reason = created.body.errors?.[0]?.message ?? created.body.message ?? `erro ${created.status}`;
  throw new HttpError(502, `GitHub recusou o pull request: ${reason}`);
}

async function openGitLabMergeRequest(input: PullRequestInput) {
  const projectUrl = `https://${input.remote.host}/api/v4/projects/${encodeURIComponent(input.remote.path)}`;
  const headers = { 'PRIVATE-TOKEN': input.token, 'Content-Type': 'application/json' };

  type MergeRequest = { web_url?: string; message?: unknown };
  const created = await api<MergeRequest>(`${projectUrl}/merge_requests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_branch: input.branch,
      target_branch: input.baseBranch,
      title: input.title,
      description: input.body,
    }),
  });
  if (created.status === 201 && created.body.web_url) return created.body.web_url;

  if (created.status === 409) {
    const existing = await api<MergeRequest[]>(
      `${projectUrl}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.branch)}`,
      { headers },
    );
    const url = Array.isArray(existing.body) ? existing.body[0]?.web_url : undefined;
    if (url) return url;
  }

  const reason = created.body.message ? JSON.stringify(created.body.message) : `erro ${created.status}`;
  throw new HttpError(502, `GitLab recusou o merge request: ${reason}`);
}
