import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';

/**
 * Who owns the entity behind each kind of route. Everything belongs to the owner of its workspace (accounts belong
 * to a user directly); requests for someone else's entity answer "not found", so ids of other users leak nothing.
 */
const ownerOfWorkspace = async (workspaceId: string | undefined) =>
  workspaceId ? (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } }))?.ownerId : null;

const OWNER_OF: Record<string, (id: string) => Promise<string | null | undefined>> = {
  '/api/workspaces/:id': async (id) => (await prisma.workspace.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId,
  '/api/git-accounts/:id': async (id) => (await prisma.gitAccount.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId,
  '/api/agent-accounts/:id': async (id) => (await prisma.agentAccount.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId,
  '/api/render-accounts/:id': async (id) => (await prisma.renderAccount.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId,
  '/api/agent-profiles/:id': async (id) => (await prisma.agentProfile.findUnique({ where: { id }, select: { workspace: { select: { ownerId: true } } } }))?.workspace.ownerId,
  '/api/agents/:id': async (id) => (await prisma.agent.findUnique({ where: { id }, select: { workspace: { select: { ownerId: true } } } }))?.workspace.ownerId,
  '/api/assistant/conversations/:id': async (id) => (await prisma.agent.findUnique({ where: { id }, select: { workspace: { select: { ownerId: true } } } }))?.workspace.ownerId,
  '/api/assistant/proposals/:id': async (id) =>
    ownerOfWorkspace((await prisma.assistantProposal.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId),
  '/api/deployments/:id': async (id) => (await prisma.deployment.findUnique({ where: { id }, select: { workspace: { select: { ownerId: true } } } }))?.workspace.ownerId,
  '/api/workflows/:id': async (id) => (await prisma.workflow.findUnique({ where: { id }, select: { workspace: { select: { ownerId: true } } } }))?.workspace.ownerId,
  '/api/workflow-runs/:id': async (id) => ownerOfWorkspace((await prisma.workflowRun.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId),
};

/** The ownership rule for a route pattern such as "/api/agents/:id/events", if it has one. */
export function ownerLookupFor(routeUrl: string) {
  const key = Object.keys(OWNER_OF).find((prefix) => routeUrl === prefix || routeUrl.startsWith(`${prefix}/`));
  return key ? OWNER_OF[key]! : null;
}

/** Throws "not found" unless the user owns the entity. */
export async function assertOwner(routeUrl: string, id: string, userId: string) {
  const lookup = ownerLookupFor(routeUrl);
  if (!lookup) return;
  if ((await lookup(id).catch(() => null)) !== userId) throw notFound('Não encontrado.');
}

export async function assertOwnsWorkspace(workspaceId: string, userId: string) {
  return assertOwner('/api/workspaces/:id', workspaceId, userId);
}

/** Ids sent in a body (agent launch: project or workspace agent). */
export async function assertOwnsProject(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspace: { select: { ownerId: true } } } });
  if (project?.workspace.ownerId !== userId) throw notFound('Projeto não encontrado.');
}

export async function assertOwnsProfile(profileId: string, userId: string) {
  return assertOwner('/api/agent-profiles/:id', profileId, userId);
}

/** Ids of the user's workspaces, to filter lists. */
export async function workspaceIdsOf(userId: string) {
  return (await prisma.workspace.findMany({ where: { ownerId: userId }, select: { id: true } })).map((workspace) => workspace.id);
}
