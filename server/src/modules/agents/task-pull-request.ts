import { HttpError } from '../../lib/errors.js';
import type { RemoteInfo } from './remote.js';

export interface TaskPullRequest {
  url: string;
  number: number;
  /** Source branch (in the same repository). */
  branch: string;
  /** Branch it merges into. */
  baseBranch: string;
}

type Json = any; // Provider responses are narrowed where they are read.

async function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * The open PR/MR that cites a task issue (e.g. "Closes #12" in its description), as a person opens it.
 * GitHub: the issue's closing references (already on the board card) or its timeline; GitLab: related MRs.
 */
export async function findTaskPullRequest(input: {
  provider: 'GITHUB' | 'GITLAB';
  remote: RemoteInfo;
  token: string;
  issueNumber: number;
  /** PR numbers the board already linked to the task. */
  knownNumbers: number[];
}): Promise<TaskPullRequest | null> {
  return input.provider === 'GITHUB' ? findOnGitHub(input) : findOnGitLab(input);
}

async function findOnGitHub(input: { remote: RemoteInfo; token: string; issueNumber: number; knownNumbers: number[] }) {
  const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
  const [owner, repo] = input.remote.path.split('/');
  const headers = { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' };

  const numbers = new Set(input.knownNumbers);
  const timeline = await get(`${apiBase}/repos/${owner}/${repo}/issues/${input.issueNumber}/timeline?per_page=100`, headers);
  if (timeline.status === 200 && Array.isArray(timeline.body)) {
    for (const event of timeline.body) {
      const source = event.event === 'cross-referenced' ? event.source?.issue : null;
      if (source?.pull_request && source.repository?.full_name?.toLowerCase() === input.remote.path.toLowerCase()) numbers.add(source.number);
    }
  }

  // The most recent open one wins.
  for (const number of [...numbers].sort((a, b) => b - a)) {
    const pull = await get(`${apiBase}/repos/${owner}/${repo}/pulls/${number}`, headers);
    if (pull.status !== 200 || pull.body?.state !== 'open') continue;
    if (pull.body.head?.repo?.full_name?.toLowerCase() !== input.remote.path.toLowerCase()) continue; // forks are not supported
    return { url: pull.body.html_url, number, branch: pull.body.head.ref, baseBranch: pull.body.base.ref };
  }
  return null;
}

async function findOnGitLab(input: { remote: RemoteInfo; token: string; issueNumber: number }) {
  const projectUrl = `https://${input.remote.host}/api/v4/projects/${encodeURIComponent(input.remote.path)}`;
  const related = await get(`${projectUrl}/issues/${input.issueNumber}/related_merge_requests?per_page=100`, { 'PRIVATE-TOKEN': input.token });
  if (related.status !== 200 || !Array.isArray(related.body)) return null;
  const open = related.body
    .filter((mr: Json) => mr.state === 'opened' && mr.source_project_id === mr.target_project_id)
    .sort((a: Json, b: Json) => b.iid - a.iid)[0];
  return open ? { url: open.web_url, number: open.iid, branch: open.source_branch, baseBranch: open.target_branch } : null;
}
