import { prisma } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { secrets } from '../../lib/secrets.js';

/**
 * Pool of shared test users of a workspace: each group of agent variables <PREFIX>_LOGIN / <PREFIX>_PASSWORD is one
 * user (<PREFIX>_TIPO says "admin" or "comum", <PREFIX>_NOTA describes it). A tester takes one before logging in and
 * gives it back when done; a user held by an agent that is no longer working, or for too long, is free again.
 */

/** Agents still working keep their users; any other status gives them back. */
const ACTIVE_STATUSES = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING'] as const;
/** A lease nobody gave back is considered abandoned after this long. */
const LEASE_MAX_MS = 4 * 3600_000;

export interface TestUser {
  prefix: string;
  login: string;
  kind: string | null;
  note: string | null;
}

/** The test users of a workspace, from its agent variables (the password is never returned). */
export async function testUsers(workspaceId: string): Promise<TestUser[]> {
  const variables = await prisma.agentVariable.findMany({ where: { workspaceId }, orderBy: { key: 'asc' } });
  const value = (key: string) => {
    const variable = variables.find((entry) => entry.key === key);
    return variable ? secrets.decrypt(variable.valueEncrypted) : null;
  };
  return variables
    .filter((variable) => variable.key.endsWith('_LOGIN') && variables.some((entry) => entry.key === variable.key.replace(/_LOGIN$/, '_PASSWORD')))
    .map((variable) => {
      const prefix = variable.key.replace(/_LOGIN$/, '');
      return { prefix, login: value(variable.key) ?? '', kind: value(`${prefix}_TIPO`)?.toLowerCase() ?? null, note: value(`${prefix}_NOTA`) };
    });
}

/** Gives back the users of agents that stopped working, and leases kept for too long. */
async function releaseStale(workspaceId: string) {
  const leases = await prisma.testUserLease.findMany({ where: { workspaceId } });
  if (leases.length === 0) return;
  const working = await prisma.agent.findMany({
    where: { id: { in: leases.map((lease) => lease.agentId) }, status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true },
  });
  const alive = new Set(working.map((agent) => agent.id));
  const stale = leases.filter((lease) => !alive.has(lease.agentId) || Date.now() - lease.acquiredAt.getTime() > LEASE_MAX_MS);
  if (stale.length > 0) await prisma.testUserLease.deleteMany({ where: { id: { in: stale.map((lease) => lease.id) } } });
}

/** Who holds each user now. */
export async function testUserStatus(workspaceId: string) {
  await releaseStale(workspaceId);
  const [users, leases] = await Promise.all([testUsers(workspaceId), prisma.testUserLease.findMany({ where: { workspaceId } })]);
  const agents = await prisma.agent.findMany({ where: { id: { in: leases.map((lease) => lease.agentId) } }, select: { id: true, title: true } });
  return users.map((user) => {
    const lease = leases.find((entry) => entry.prefix === user.prefix);
    const holder = lease ? agents.find((agent) => agent.id === lease.agentId) : undefined;
    return {
      ...user,
      inUse: Boolean(lease),
      heldBy: lease ? { agentId: lease.agentId, title: holder?.title ?? null, since: lease.acquiredAt.toISOString(), purpose: lease.purpose } : null,
    };
  });
}

/**
 * Takes a free test user for the agent (of the given kind, when asked). Returns the variables to read, or the users
 * in use when none is free (the agent waits and asks again).
 */
export async function acquireTestUser(workspaceId: string, agentId: string, input: { kind?: string | null; purpose?: string | null }) {
  const kind = input.kind?.trim().toLowerCase() || null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await testUserStatus(workspaceId);
    const candidates = status.filter((user) => !user.inUse && (!kind || user.kind === kind));
    if (candidates.length === 0) {
      const ofKind = status.filter((user) => !kind || user.kind === kind);
      return {
        acquired: false,
        message:
          ofKind.length === 0
            ? `Nenhum usuário de teste${kind ? ` do tipo "${kind}"` : ''} cadastrado nas variáveis do workspace.`
            : 'Todos os usuários de teste desse tipo estão em uso: espere uns minutos e peça de novo (ou devolva um seu que não está usando).',
        inUse: ofKind.map((user) => ({ prefix: user.prefix, kind: user.kind, heldBy: user.heldBy })),
      };
    }
    const user = candidates[0]!;
    try {
      await prisma.testUserLease.create({ data: { workspaceId, prefix: user.prefix, agentId, purpose: (input.purpose ?? '').slice(0, 300) } });
    } catch (error) {
      // Another tester took it at the same moment: try the next free one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
    return {
      acquired: true,
      prefix: user.prefix,
      login: user.login,
      kind: user.kind,
      note: user.note,
      variables: [`${user.prefix}_LOGIN`, `${user.prefix}_PASSWORD`],
      message: `Usuário ${user.prefix} reservado para você: faça login com ${user.prefix}_LOGIN / ${user.prefix}_PASSWORD (em /run/studio/variables.env). Devolva com test_user_release assim que não precisar mais.`,
    };
  }
  return { acquired: false, message: 'Outros testers estão pegando usuários ao mesmo tempo: peça de novo em instantes.' };
}

/** Gives back one of the agent's users (or all of them, without a prefix). */
export async function releaseTestUser(workspaceId: string, agentId: string, prefix?: string | null) {
  const { count } = await prisma.testUserLease.deleteMany({ where: { workspaceId, agentId, ...(prefix ? { prefix } : {}) } });
  return { released: count };
}
