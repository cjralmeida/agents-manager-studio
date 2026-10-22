import { HttpError } from '../../lib/errors.js';
import { type GuardedProject, assertMergeTarget } from './branch-guard.js';
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

const CONFLICT_MARK = 'tem conflitos com a branch de destino';

/** Whether a merge failure was a conflict with the base branch (as opposed to a token, permission or API problem). */
export function isConflictMessage(message: string) {
  return message.includes(CONFLICT_MARK);
}

export interface MergeInput {
  provider: 'GITHUB' | 'GITLAB';
  remote: RemoteInfo;
  token: string;
  number: number;
}

/**
 * Merges a PR (GitHub) or MR (GitLab) and returns the resulting commit. GitLab answers "not mergeable"
 * for a few seconds after an MR is created, so refusals are retried before giving up.
 */
export async function mergePullRequest(input: MergeInput): Promise<string | null> {
  let lastReason = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    const result = input.provider === 'GITHUB' ? await mergeGitHub(input) : await mergeGitLab(input);
    if (result.merged) return result.commit;
    lastReason = result.reason;
    if (!result.retry) break;
    if (input.provider === 'GITLAB') {
      // GitLab refuses a merge (405) both on a real conflict and while its mergeability check is stale or stuck
      // ("checking", "preparing", even "conflict" with no conflict). A real conflict ends the retries at once (the work
      // goes back to the builder); otherwise the check is asked again and the merge retried.
      const state = await gitLabMergeState(input);
      if (state?.hasConflicts) {
        lastReason = `${lastReason} — o GitLab confirma conflito com a branch de destino`;
        break;
      }
      await gitLabRecheck(input);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 3_000, 15_000)));
  }
  const conflict = /405|406|conflict|cannot be merged|not mergeable/i.test(lastReason);
  throw new HttpError(
    502,
    conflict
      ? `O PR/MR não pôde ser mesclado: provavelmente ${CONFLICT_MARK} (${lastReason}).`
      : `Não foi possível fazer o merge: ${lastReason}`,
  );
}

async function mergeGitHub(input: MergeInput) {
  const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
  const [owner, repo] = input.remote.path.split('/');
  type Merge = { merged?: boolean; sha?: string; message?: string };
  const response = await api<Merge>(`${apiBase}/repos/${owner}/${repo}/pulls/${input.number}/merge`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agents-manager-studio',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  if (response.status === 200 && response.body.merged) {
    await deleteMergedAgentBranch(apiBase, owner!, repo!, input);
    return { merged: true, commit: response.body.sha ?? null, reason: '', retry: false };
  }
  return { merged: false, commit: null, reason: response.body.message ?? `erro ${response.status}`, retry: response.status === 405 };
}

/**
 * After a merge, the agent's branch is deleted (GitLab does it with "should_remove_source_branch"). Only the Studio's
 * own branches ("agent/..."): a branch someone else opened stays for them to delete. Failures are ignored.
 */
async function deleteMergedAgentBranch(apiBase: string, owner: string, repo: string, input: MergeInput) {
  const headers = { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' };
  try {
    const pull = await api<{ head?: { ref?: string; repo?: { full_name?: string } } }>(`${apiBase}/repos/${owner}/${repo}/pulls/${input.number}`, { headers });
    const branch = pull.body.head?.ref;
    const sameRepo = pull.body.head?.repo?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase();
    if (!branch || !sameRepo || !branch.startsWith('agent/')) return;
    await api(`${apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers });
  } catch {
    // The branch stays; it is only clutter.
  }
}

async function mergeGitLab(input: MergeInput) {
  const projectUrl = `https://${input.remote.host}/api/v4/projects/${encodeURIComponent(input.remote.path)}`;
  type MergeRequest = { state?: string; merge_commit_sha?: string; squash_commit_sha?: string; message?: unknown };
  const response = await api<MergeRequest>(`${projectUrl}/merge_requests/${input.number}/merge`, {
    method: 'PUT',
    headers: { 'PRIVATE-TOKEN': input.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ should_remove_source_branch: true }),
  });
  if (response.status === 200 && response.body.state === 'merged') {
    await deleteMergedGitLabBranch(projectUrl, input);
    return { merged: true, commit: response.body.merge_commit_sha ?? response.body.squash_commit_sha ?? null, reason: '', retry: false };
  }
  const reason = response.body.message ? JSON.stringify(response.body.message) : `erro ${response.status}`;
  // 405/406/422: still checking mergeability, or a conflict; worth a few retries.
  return { merged: false, commit: null, reason, retry: [405, 406, 422].includes(response.status) };
}

/**
 * "should_remove_source_branch" is only a request: GitLab sometimes keeps the branch (gf-novo-oficial kept 10 task
 * branches). After the merge the Studio deletes it itself when it is merged, not protected and no other open MR uses it.
 * Failures are ignored.
 */
async function deleteMergedGitLabBranch(projectUrl: string, input: MergeInput) {
  const headers = { 'PRIVATE-TOKEN': input.token };
  try {
    const mr = await api<{ source_branch?: string; source_project_id?: number; target_project_id?: number }>(`${projectUrl}/merge_requests/${input.number}`, { headers });
    const branch = mr.body.source_branch;
    if (!branch || mr.body.source_project_id !== mr.body.target_project_id) return;
    const branchUrl = `${projectUrl}/repository/branches/${encodeURIComponent(branch)}`;
    const current = await api<{ merged?: boolean; protected?: boolean; default?: boolean }>(branchUrl, { headers });
    if (current.status !== 200 || !current.body.merged || current.body.protected || current.body.default) return;
    const others = await api<unknown[]>(`${projectUrl}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`, { headers });
    if (others.status !== 200 || others.body.length > 0) return;
    await api(branchUrl, { method: 'DELETE', headers });
  } catch {
    // The branch stays; it is only clutter.
  }
}

const gitLabMergeRequestUrl = (input: MergeInput) =>
  `https://${input.remote.host}/api/v4/projects/${encodeURIComponent(input.remote.path)}/merge_requests`;

/** Whether GitLab sees a real conflict in the MR, and its detailed merge status. Null when it could not be read. */
async function gitLabMergeState(input: MergeInput) {
  type MergeRequest = { has_conflicts?: boolean; detailed_merge_status?: string };
  const response = await api<MergeRequest>(`${gitLabMergeRequestUrl(input)}/${input.number}`, { headers: { 'PRIVATE-TOKEN': input.token } }).catch(
    () => null,
  );
  if (!response || response.status !== 200) return null;
  return { hasConflicts: response.body.has_conflicts === true, status: response.body.detailed_merge_status ?? null };
}

/** Asks GitLab to check the MR's mergeability again (a stale check keeps refusing merges). */
async function gitLabRecheck(input: MergeInput) {
  await api(`${gitLabMergeRequestUrl(input)}?iids[]=${input.number}&with_merge_status_recheck=true`, { headers: { 'PRIVATE-TOKEN': input.token } }).catch(
    () => undefined,
  );
}

export type PullRequestState = 'open' | 'merged' | 'closed';

/** Whether a PR/MR is open, merged or closed, and the branch it merges into, as the provider says. */
export async function pullRequestInfo(input: MergeInput): Promise<{ state: PullRequestState; target: string; source: string }> {
  if (input.provider === 'GITHUB') {
    const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
    const [owner, repo] = input.remote.path.split('/');
    const response = await api<{ state?: string; merged?: boolean; message?: string; base?: { ref?: string }; head?: { ref?: string } }>(
      `${apiBase}/repos/${owner}/${repo}/pulls/${input.number}`,
      { headers: { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' } },
    );
    if (response.status !== 200) throw new HttpError(502, `GitHub: ${response.body.message ?? `erro ${response.status}`}`);
    const state = response.body.merged ? 'merged' : response.body.state === 'open' ? 'open' : 'closed';
    return { state, target: response.body.base?.ref ?? '', source: response.body.head?.ref ?? '' };
  }
  const projectUrl = `https://${input.remote.host}/api/v4/projects/${encodeURIComponent(input.remote.path)}`;
  const response = await api<{ state?: string; message?: unknown; target_branch?: string; source_branch?: string }>(`${projectUrl}/merge_requests/${input.number}`, {
    headers: { 'PRIVATE-TOKEN': input.token },
  });
  if (response.status !== 200) throw new HttpError(502, `GitLab: ${JSON.stringify(response.body.message ?? `erro ${response.status}`)}`);
  const state = response.body.state === 'merged' ? 'merged' : response.body.state === 'opened' ? 'open' : 'closed';
  return { state, target: response.body.target_branch ?? '', source: response.body.source_branch ?? '' };
}

/** Leaves a comment on a PR/MR. */
export async function commentPullRequest(input: MergeInput, comment: string) {
  if (input.provider === 'GITHUB') {
    const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
    const [owner, repo] = input.remote.path.split('/');
    const headers = {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agents-manager-studio',
      'Content-Type': 'application/json',
    };
    const posted = await api<{ message?: string }>(`${apiBase}/repos/${owner}/${repo}/issues/${input.number}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: comment }),
    });
    if (posted.status !== 201) throw new HttpError(502, `GitHub: ${posted.body.message ?? `erro ${posted.status}`}`);
    return;
  }
  const posted = await api<{ message?: unknown }>(`${gitLabMergeRequestUrl(input)}/${input.number}/notes`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': input.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: comment }),
  });
  if (posted.status !== 201) throw new HttpError(502, `GitLab: ${JSON.stringify(posted.body.message ?? `erro ${posted.status}`)}`);
}

/** Closes a PR/MR without merging it, leaving a comment that says why. */
export async function closePullRequest(input: MergeInput, comment: string) {
  if (input.provider === 'GITHUB') {
    const apiBase = input.remote.host === 'github.com' ? 'https://api.github.com' : `https://${input.remote.host}/api/v3`;
    const [owner, repo] = input.remote.path.split('/');
    const headers = {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agents-manager-studio',
      'Content-Type': 'application/json',
    };
    await commentPullRequest(input, comment).catch(() => undefined); // the close says why; it still closes without the comment
    const closed = await api<{ message?: string }>(`${apiBase}/repos/${owner}/${repo}/pulls/${input.number}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ state: 'closed' }),
    });
    if (closed.status !== 200) throw new HttpError(502, `GitHub: ${closed.body.message ?? `erro ${closed.status}`}`);
    return;
  }
  const headers = { 'PRIVATE-TOKEN': input.token, 'Content-Type': 'application/json' };
  const url = `${gitLabMergeRequestUrl(input)}/${input.number}`;
  await commentPullRequest(input, comment).catch(() => undefined); // the close says why; it still closes without the comment
  const closed = await api<{ message?: unknown }>(url, { method: 'PUT', headers, body: JSON.stringify({ state_event: 'close' }) });
  if (closed.status !== 200) throw new HttpError(502, `GitLab: ${JSON.stringify(closed.body.message ?? `erro ${closed.status}`)}`);
}

export async function pullRequestState(input: MergeInput): Promise<PullRequestState> {
  return (await pullRequestInfo(input)).state;
}

/**
 * The only way agents' work is merged: the PR/MR must target the allowed base (checked on the provider right before
 * merging, so a PR retargeted to "master" is refused).
 */
export async function mergeIntoBase(input: MergeInput & { project: GuardedProject; expectedBase: string }) {
  const label = `${input.provider === 'GITHUB' ? 'O PR #' : 'O MR !'}${input.number}`;
  const { state, target } = await pullRequestInfo(input);
  assertMergeTarget(input.project, input.expectedBase, target, label);
  // Merged already (e.g. by whoever made it outside the Studio): the deploy takes the base as it is.
  if (state === 'merged') return null;
  return mergePullRequest(input);
}
