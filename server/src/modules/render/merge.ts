import { prisma } from '../../db.js';
import type { Deployment } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { mergeIntoBase } from '../agents/pull-requests.js';
import { closeSupersededPullRequests } from '../agents/superseded.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { pullRequestNumber } from './status.js';

/** Start of a deploy error when the PR/MR could not be merged (usually a conflict with the base): a workflow sends the
 * work back with the base merged into the copy, as for a conflict found in review. */
export const MERGE_REFUSED = 'O merge do PR/MR foi recusado';

/**
 * Merges the deploy's PR/MR (if any) into the branch the service deploys from; returns the merge commit, or null when
 * there was nothing to merge (or it was already merged). Shared by the Render and AWS deploys.
 */
export async function mergeDeploymentPullRequest(deployment: Deployment): Promise<string | null> {
  if (!deployment.prUrl || !deployment.projectId) return null;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: deployment.projectId } });
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  const number = pullRequestNumber(deployment.prUrl);
  if (!remote || !number) throw new HttpError(422, 'Não foi possível identificar o PR/MR para o merge.');
  const account = await findWorkspaceGitAccount(deployment.workspaceId, [remoteHostname(remote), remote.host]);
  const agent = deployment.agentId ? await prisma.agent.findUnique({ where: { id: deployment.agentId } }) : null;
  const expectedBase = agent?.baseBranch ?? project.baseBranch;
  if (!expectedBase) throw new HttpError(422, 'Não foi possível saber para qual branch o PR/MR pode ser mesclado.');
  const commit = await mergeIntoBase({
    provider: account.provider as 'GITHUB' | 'GITLAB',
    remote,
    token: secrets.decrypt(account.tokenEncrypted),
    number,
    project,
    expectedBase,
  }).catch((error: unknown) => {
    throw new Error(`${MERGE_REFUSED}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (agent) await closeSupersededPullRequests(agent, deployment.prUrl).catch((error: unknown) => console.error('PR/MRs substituídos:', error));
  return commit;
}
