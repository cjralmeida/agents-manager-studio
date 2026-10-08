import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';

/**
 * The git account linked to the workspace for a host. Each workspace has at most one account per host,
 * so the host of a remote (or board) identifies the credentials to use.
 */
export async function findWorkspaceGitAccount(workspaceId: string, hosts: string[]) {
  const link = await prisma.workspaceGitAccount.findFirst({
    where: { workspaceId, gitAccount: { host: { in: hosts } } },
    include: { gitAccount: true },
  });
  if (!link) {
    throw new HttpError(422, `Nenhuma conta git para ${hosts[0]} está vinculada a este workspace.`);
  }
  return link.gitAccount;
}
