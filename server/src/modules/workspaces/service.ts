import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { Project, Workspace } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { toHostPath } from '../../lib/paths.js';
import { scanProjectsRoot } from './scanner.js';

export interface ScanSummary {
  workspaces: { total: number; added: number; missing: number };
  projects: { total: number; added: number; missing: number };
}

/** Syncs the database with the folders on disk. Folders that disappeared are flagged, never deleted. */
export async function scanWorkspaces(): Promise<ScanSummary> {
  const scanned = await scanProjectsRoot(config.projectsDir, config.scanExclude);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspace.findMany({ include: { projects: { select: { name: true } } } });
    const existingByName = new Map(existing.map((workspace) => [workspace.name, workspace]));
    const summary: ScanSummary = {
      workspaces: { total: scanned.length, added: 0, missing: 0 },
      projects: { total: 0, added: 0, missing: 0 },
    };

    for (const scannedWorkspace of scanned) {
      const current = existingByName.get(scannedWorkspace.name);
      const workspace = await tx.workspace.upsert({
        where: { name: scannedWorkspace.name },
        create: { name: scannedWorkspace.name },
        update: { missingAt: null },
      });
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
        if (!knownProjects.has(project.name)) summary.projects.added++;
      }
      summary.projects.total += scannedWorkspace.projects.length;

      const missingProjects = await tx.project.updateMany({
        where: {
          workspaceId: workspace.id,
          missingAt: null,
          name: { notIn: scannedWorkspace.projects.map((project) => project.name) },
        },
        data: { missingAt: now },
      });
      summary.projects.missing += missingProjects.count;
    }

    const missingWorkspaces = await tx.workspace.updateMany({
      where: { missingAt: null, name: { notIn: scanned.map((workspace) => workspace.name) } },
      data: { missingAt: now },
    });
    summary.workspaces.missing = missingWorkspaces.count;

    return summary;
  });
}

export async function listWorkspaces(options: { includeIgnored: boolean }) {
  const workspaces = await prisma.workspace.findMany({
    where: options.includeIgnored ? {} : { isIgnored: false },
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
    isMissing: project.missingAt !== null,
  };
}
