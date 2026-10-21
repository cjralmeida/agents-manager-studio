import { z } from 'zod';
import { prisma } from '../../db.js';
import type { Prisma, Project } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';

/**
 * Systems of a workspace: a system is one product, made of one or more projects (e.g. the API and its front), whose
 * documentation and roadmap live in one place — its docs home. The home is a project and a folder in it: the game's
 * own repository ("docs"), or a shared documentation repository ("sistemas/plataforma-web" in the docs repo).
 * A project in no system is a system by itself, documented in its own docs/ folder.
 */
const key = (workspaceId: string) => `systems:${workspaceId}`;

const docsPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.-]+(\/[\w.-]+)*$/, 'Use uma pasta relativa ao repositório, como "docs" ou "sistemas/plataforma-web".')
  .refine((value) => !value.split('/').includes('..'), { message: 'A pasta não pode subir de nível.' });

export const systemsSchema = z
  .object({
    systems: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            /** The system's projects; the first is the main one ("#N" in the roadmap means a task of it). */
            projectIds: z.array(z.uuid()).min(1).max(30),
            docsProjectId: z.uuid(),
            docsPath,
          })
          .strict(),
      )
      .max(50)
      .refine((systems) => new Set(systems.map((system) => system.name.toLowerCase())).size === systems.length, { message: 'Dois sistemas com o mesmo nome.' })
      .refine((systems) => new Set(systems.flatMap((system) => system.projectIds)).size === systems.flatMap((system) => system.projectIds).length, {
        message: 'Um projeto está em mais de um sistema.',
      }),
  })
  .strict();

export type SystemsSettings = z.infer<typeof systemsSchema>;

export interface ResolvedSystem {
  /** The name for a configured system; "project:<id>" for a project that is a system by itself. */
  id: string;
  name: string;
  implicit: boolean;
  projects: Project[];
  docsProject: Project;
  docsPath: string;
  roadmapFile: string;
}

export async function systemsSettings(workspaceId: string): Promise<SystemsSettings> {
  const row = await prisma.studioSetting.findUnique({ where: { key: key(workspaceId) } });
  const parsed = systemsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : { systems: [] };
}

export async function saveSystemsSettings(workspaceId: string, input: SystemsSettings) {
  const ids = [...new Set(input.systems.flatMap((system) => [...system.projectIds, system.docsProjectId]))];
  const found = await prisma.project.count({ where: { id: { in: ids }, workspaceId } });
  if (found !== ids.length) throw new HttpError(422, 'Algum projeto não pertence a este workspace.');
  const value = input as unknown as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key: key(workspaceId) }, create: { key: key(workspaceId), value }, update: { value } });
  return input;
}

/** Every system of the workspace: the configured ones, then each remaining project on its own (docs homes excluded). */
export async function workspaceSystems(workspaceId: string): Promise<ResolvedSystem[]> {
  const [projects, settings] = await Promise.all([
    prisma.project.findMany({ where: { workspaceId, missingAt: null }, orderBy: { name: 'asc' } }),
    systemsSettings(workspaceId),
  ]);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const configured = settings.systems.flatMap((system): ResolvedSystem[] => {
    const docsProject = byId.get(system.docsProjectId);
    const members = system.projectIds.flatMap((id) => byId.get(id) ?? []);
    if (!docsProject || members.length === 0) return [];
    return [{ id: system.name, name: system.name, implicit: false, projects: members, docsProject, docsPath: system.docsPath, roadmapFile: `${system.docsPath}/roadmap.md` }];
  });
  const taken = new Set(configured.flatMap((system) => [...system.projects.map((project) => project.id), system.docsProject.id]));
  const alone = projects
    .filter((project) => !taken.has(project.id))
    .map((project): ResolvedSystem => ({ id: `project:${project.id}`, name: project.name, implicit: true, projects: [project], docsProject: project, docsPath: 'docs', roadmapFile: 'docs/roadmap.md' }));
  return [...configured, ...alone];
}

/** The system a project belongs to (a project in none is its own system; a shared docs home belongs to none). */
export async function systemOfProject(workspaceId: string, projectId: string) {
  const systems = await workspaceSystems(workspaceId);
  return systems.find((system) => system.projects.some((project) => project.id === projectId)) ?? null;
}

/** A system by its name, or the system of the project with that name (agents may name either). */
export async function findSystem(workspaceId: string, name: string) {
  const systems = await workspaceSystems(workspaceId);
  const wanted = name.trim().toLowerCase();
  const system =
    systems.find((entry) => entry.name.toLowerCase() === wanted) ??
    systems.find((entry) => entry.projects.some((project) => project.name.toLowerCase() === wanted));
  if (!system) throw new HttpError(404, `Sistema ou projeto "${name}" não encontrado. Sistemas: ${systems.map((entry) => entry.name).join(', ')}.`);
  return system;
}
