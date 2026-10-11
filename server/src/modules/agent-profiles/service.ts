import { prisma } from '../../db.js';
import { type AgentProfile, Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import type { AgentModel } from '../agents/service.js';

import type { PROFILE_TOOLS } from './schema.js';

export interface AgentProfileInput {
  name: string;
  description: string;
  instructions: string;
  model: AgentModel;
  projectIds: string[];
  contextProjectIds: string[];
  anyProject: boolean;
  output: 'PULL_REQUEST' | 'RESULT';
  tools: (typeof PROFILE_TOOLS)[number][];
  autoConclude: boolean;
  autoMerge: boolean;
}

const WORKING_STATUSES = ['PREPARING', 'RUNNING', 'WAITING_INPUT'] as const;

async function toResponse(profile: AgentProfile & { workspace?: { name: string } }) {
  const [working, total] = await Promise.all([
    prisma.agent.count({ where: { profileId: profile.id, status: { in: [...WORKING_STATUSES] } } }),
    prisma.agent.count({ where: { profileId: profile.id } }),
  ]);
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    workspaceName: profile.workspace?.name ?? null,
    name: profile.name,
    description: profile.description,
    instructions: profile.instructions,
    model: profile.model,
    projectIds: profile.projectIds,
    contextProjectIds: profile.contextProjectIds,
    anyProject: profile.anyProject,
    // Without projects there is no code to deliver.
    output: profile.projectIds.length === 0 && !profile.anyProject ? 'RESULT' : profile.output,
    tools: profile.tools,
    autoConclude: profile.autoConclude,
    autoMerge: profile.autoMerge && (profile.projectIds.length > 0 || profile.anyProject) && profile.output === 'PULL_REQUEST',
    workingAgents: working,
    totalAgents: total,
    createdAt: profile.createdAt,
  };
}

/** Projects must belong to the workspace and have git. */
async function validateProjects(workspaceId: string, projectIds: string[]) {
  const unique = [...new Set(projectIds)];
  const valid = await prisma.project.count({ where: { id: { in: unique }, workspaceId, isGitRepo: true, missingAt: null } });
  if (valid !== unique.length) throw new HttpError(422, 'Um ou mais projetos não são projetos com git deste workspace.');
  return unique;
}

/** Reference projects only need to exist in the workspace (git or not). */
async function validateContextProjects(workspaceId: string, projectIds: string[]) {
  const unique = [...new Set(projectIds)];
  const valid = await prisma.project.count({ where: { id: { in: unique }, workspaceId, missingAt: null } });
  if (valid !== unique.length) throw new HttpError(422, 'Um ou mais projetos de consulta não são deste workspace.');
  return unique;
}

function duplicateName(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Agents of every workspace, for the general dashboard. */
export async function listAllAgentProfiles(ownerId: string) {
  const profiles = await prisma.agentProfile.findMany({
    where: { workspace: { ownerId, isIgnored: false, missingAt: null } },
    include: { workspace: { select: { name: true } } },
    orderBy: [{ workspace: { name: 'asc' } }, { name: 'asc' }],
  });
  return Promise.all(profiles.map(toResponse));
}

export async function listAgentProfiles(workspaceId: string) {
  const profiles = await prisma.agentProfile.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
  return Promise.all(profiles.map(toResponse));
}

export async function createAgentProfile(workspaceId: string, input: AgentProfileInput) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  const projectIds = await validateProjects(workspaceId, input.projectIds);
  const contextProjectIds = await validateContextProjects(workspaceId, input.contextProjectIds ?? []);
  try {
    const profile = await prisma.agentProfile.create({ data: { workspaceId, ...input, projectIds, contextProjectIds } });
    return toResponse(profile);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, `Já existe um agente chamado "${input.name}" neste workspace.`);
    throw error;
  }
}

export async function updateAgentProfile(id: string, input: Partial<AgentProfileInput>) {
  const current = await findOrThrow(id);
  const projectIds = input.projectIds ? await validateProjects(current.workspaceId, input.projectIds) : undefined;
  const contextProjectIds = input.contextProjectIds ? await validateContextProjects(current.workspaceId, input.contextProjectIds) : undefined;
  try {
    const profile = await prisma.agentProfile.update({
      where: { id },
      data: { ...input, ...(projectIds && { projectIds }), ...(contextProjectIds && { contextProjectIds }) },
    });
    return toResponse(profile);
  } catch (error) {
    if (duplicateName(error)) throw new HttpError(409, `Já existe um agente chamado "${input.name}" neste workspace.`);
    throw error;
  }
}

/** Executions already launched keep running; they just lose the link to the profile. */
export async function deleteAgentProfile(id: string) {
  await findOrThrow(id);
  await prisma.agentProfile.delete({ where: { id } });
}

async function findOrThrow(id: string) {
  const profile = await prisma.agentProfile.findUnique({ where: { id } });
  if (!profile) throw notFound('Agente do workspace não encontrado.');
  return profile;
}
