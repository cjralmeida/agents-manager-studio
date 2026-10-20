import { prisma } from '../../db.js';
import type { Agent } from '../../generated/prisma/client.js';
import { secrets } from '../../lib/secrets.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { pullRequestNumber } from '../render/status.js';
import { closePullRequest, pullRequestInfo } from './pull-requests.js';
import { parseRemote, remoteHostname } from './remote.js';

/**
 * Once a delivery of a task is merged, the other PR/MRs the Studio's agents opened for the same task are closed without
 * merging (an earlier attempt, left behind when the task was redone from scratch): the merged one is the approved
 * version, and joining both would mix two implementations. Only the Studio's own branches ("agent/..."): a PR/MR
 * someone else opened is theirs. Returns the urls closed; one that could not be closed stays open and is logged.
 */
export async function closeSupersededPullRequests(agent: Pick<Agent, 'workspaceId' | 'projectId' | 'taskRef'>, mergedUrl: string) {
  if (!agent.taskRef || !agent.projectId) return [];
  const others = await prisma.agent.findMany({
    where: { workspaceId: agent.workspaceId, projectId: agent.projectId, taskRef: agent.taskRef, prUrl: { not: null } },
    select: { prUrl: true },
  });
  const urls = [...new Set(others.map((other) => other.prUrl!))].filter((url) => url !== mergedUrl);
  if (urls.length === 0) return [];
  const project = await prisma.project.findUniqueOrThrow({ where: { id: agent.projectId } });
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) return [];
  const account = await findWorkspaceGitAccount(agent.workspaceId, [remoteHostname(remote), remote.host]);
  const access = { provider: account.provider as 'GITHUB' | 'GITLAB', remote, token: secrets.decrypt(account.tokenEncrypted) };
  const closed: string[] = [];
  for (const url of urls) {
    const number = pullRequestNumber(url);
    if (!number) continue;
    try {
      const info = await pullRequestInfo({ ...access, number });
      if (info.state !== 'open' || !info.source.startsWith('agent/')) continue;
      await closePullRequest(
        { ...access, number },
        `Substituído por ${mergedUrl}: a tarefa ${agent.taskRef} foi refeita e essa entrega já foi mesclada. Fechado sem merge pelo Agents Manager Studio (juntar os dois misturaria duas implementações da mesma tarefa).`,
      );
      closed.push(url);
    } catch (error) {
      console.error(`Não foi possível fechar ${url}, substituído por ${mergedUrl}:`, error);
    }
  }
  return closed;
}
