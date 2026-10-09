import { config } from '../../config.js';
import { git } from '../../lib/git.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { prisma } from '../../db.js';
import type { Project, Workspace } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { mkdir, stat } from 'node:fs/promises';
import { toContainerPath, toHostPath } from '../../lib/paths.js';
import { workspaceNameProblem } from './names.js';
import { scanProjectsRoot } from './scanner.js';

export interface ScanSummary {
  workspaces: { total: number; added: number; missing: number };
  projects: { total: number; added: number; missing: number };
}

/** Creates the workspace folder in the central folder and registers it for the user (with a scan). */
export async function createWorkspace(ownerId: string, name: string) {
  const trimmed = name.trim();
  const problem = workspaceNameProblem(trimmed, config.scanExclude);
  if (problem) throw new HttpError(422, problem);

  const folder = toContainerPath(trimmed);
  const exists = await stat(folder).then(
    () => true,
    () => false,
  );
  // Folder names are compared without case on Windows, so an existing workspace with another case also clashes.
  const clash = await prisma.workspace.findFirst({ where: { name: { equals: trimmed, mode: 'insensitive' } } });
  if (exists || clash) throw new HttpError(409, `Já existe uma pasta "${clash?.name ?? trimmed}" na pasta central.`);

  try {
    await mkdir(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      throw new HttpError(503, 'A pasta central está montada somente para leitura no Studio; não é possível criar pastas nela.');
    }
    throw error;
  }
  await scanWorkspaces(ownerId);
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { name: trimmed } });
  return getWorkspace(workspace.id);
}

/**
 * Syncs the database with the folders on disk. Folders that disappeared are flagged, never deleted. A new folder
 * becomes a workspace of `ownerId` (the user who asked for the scan); scans without one (startup, after a clone)
 * only update the workspaces that already exist. The summary counts the owner's workspaces only.
 */
export async function scanWorkspaces(ownerId?: string): Promise<ScanSummary> {
  const scanned = await scanProjectsRoot(config.projectsDir, config.scanExclude);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspace.findMany({ include: { projects: { select: { name: true } } } });
    const existingByName = new Map(existing.map((workspace) => [workspace.name, workspace]));
    const summary: ScanSummary = {
      workspaces: { total: 0, added: 0, missing: 0 },
      projects: { total: 0, added: 0, missing: 0 },
    };

    for (const scannedWorkspace of scanned) {
      const current = existingByName.get(scannedWorkspace.name);
      if (!current && !ownerId) continue;
      const workspace = current
        ? await tx.workspace.update({ where: { id: current.id }, data: { missingAt: null } })
        : await tx.workspace.create({ data: { name: scannedWorkspace.name, ownerId: ownerId! } });
      const counts = !ownerId || workspace.ownerId === ownerId;
      if (counts) summary.workspaces.total++;
      if (!current) summary.workspaces.added++;

      const knownProjects = new Set(current?.projects.map((project) => project.name));
      for (const project of scannedWorkspace.projects) {
        const gitInfo = {
          isGitRepo: project.isGitRepo,
          gitRemoteUrl: project.gitRemoteUrl,
          gitProvider: project.gitProvider,
        };
        await tx.project.upsert({
          where: { workspaceId_name: { workspaceId: workspace.id, name: project.name } },
          create: { workspaceId: workspace.id, name: project.name, ...gitInfo },
          update: { ...gitInfo, missingAt: null },
        });
        if (counts && !knownProjects.has(project.name)) summary.projects.added++;
      }
      if (counts) summary.projects.total += scannedWorkspace.projects.length;

      const missingProjects = await tx.project.updateMany({
        where: {
          workspaceId: workspace.id,
          missingAt: null,
          name: { notIn: scannedWorkspace.projects.map((project) => project.name) },
        },
        data: { missingAt: now },
      });
      if (counts) summary.projects.missing += missingProjects.count;
    }

    const missingWhere = { missingAt: null, name: { notIn: scanned.map((workspace) => workspace.name) } };
    const missingOfOwner = ownerId ? await tx.workspace.count({ where: { ...missingWhere, ownerId } }) : null;
    const missingWorkspaces = await tx.workspace.updateMany({ where: missingWhere, data: { missingAt: now } });
    summary.workspaces.missing = missingOfOwner ?? missingWorkspaces.count;

    return summary;
  });
}

/** The user's workspaces that the active view profile shows (all of them with `ignoreProfile`). */
export async function listWorkspaces(ownerId: string, options: { includeIgnored: boolean; ignoreProfile?: boolean }) {
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId, ...(!options.ignoreProfile && (await visibleWorkspaceFilter(ownerId))), ...(!options.includeIgnored && { isIgnored: false }) },
    orderBy: [{ missingAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    include: { projects: { where: { missingAt: null }, select: { isGitRepo: true } } },
  });

  return workspaces.map(({ projects, ...workspace }) => ({
    ...toWorkspaceResponse(workspace),
    projectCount: projects.length,
    gitProjectCount: projects.filter((project) => project.isGitRepo).length,
  }));
}

export async function getWorkspace(id: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    include: { projects: { orderBy: [{ missingAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }] } },
  });
  if (!workspace) throw notFound('Workspace não encontrado.');

  const { projects, ...rest } = workspace;
  return {
    ...toWorkspaceResponse(rest),
    projects: projects.map((project) => toProjectResponse(project, workspace.name)),
  };
}

export async function setWorkspaceIgnored(id: string, isIgnored: boolean) {
  const exists = await prisma.workspace.count({ where: { id } });
  if (!exists) throw notFound('Workspace não encontrado.');

  await prisma.workspace.update({ where: { id }, data: { isIgnored } });
  return getWorkspace(id);
}

/** Only workspaces whose folder no longer exists can be removed; existing folders come back on the next scan. */
export async function deleteMissingWorkspace(id: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id }, select: { missingAt: true } });
  if (!workspace) throw notFound('Workspace não encontrado.');
  if (workspace.missingAt === null) {
    throw new HttpError(409, 'Só é possível remover workspaces cuja pasta não existe mais. Use "ignorar" para escondê-lo.');
  }

  await prisma.workspace.delete({ where: { id } });
}

function toWorkspaceResponse(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    hostPath: toHostPath(workspace.name),
    isIgnored: workspace.isIgnored,
    isMissing: workspace.missingAt !== null,
  };
}

function toProjectResponse(project: Project, workspaceName: string) {
  return {
    id: project.id,
    name: project.name,
    hostPath: toHostPath(workspaceName, project.name),
    isGitRepo: project.isGitRepo,
    gitRemoteUrl: project.gitRemoteUrl,
    gitProvider: project.gitProvider,
    baseBranch: project.baseBranch,
    isMissing: project.missingAt !== null,
  };
}

/**
 * Branch agents start from and open PRs/MRs into (e.g. the homologation branch); null goes back to the folder's
 * current branch. It must exist in the local repository, which agents clone.
 */
export async function setProjectBaseBranch(workspaceId: string, projectId: string, baseBranch: string | null) {
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) throw new HttpError(404, 'Projeto não encontrado.');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (baseBranch) {
    const exists = await git(toContainerPath(workspace.name, project.name), ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]).then(
      () => true,
      () => false,
    );
    if (!exists) throw new HttpError(422, `A branch "${baseBranch}" não existe no repositório local do projeto. Faça checkout ou fetch dela antes.`);
  }
  const saved = await prisma.project.update({ where: { id: projectId }, data: { baseBranch } });
  return toProjectResponse(saved, workspace.name);
}
