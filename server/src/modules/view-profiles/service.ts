import { randomUUID } from 'node:crypto';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';

/**
 * View profiles: named sets of workspaces a user looks at (e.g. "Tech Lead - GlobalRas"). The active profile filters
 * the lists of workspaces, executions, tasks and usage; it changes nothing that runs. Without an active profile the
 * user sees every workspace ("Visão geral").
 */

const KEY = 'viewProfiles';

export interface ViewProfile {
  id: string;
  name: string;
  workspaceIds: string[];
}

interface Stored {
  profiles: ViewProfile[];
  activeId: string | null;
}

/** The user's profiles, without workspaces that no longer exist; an active id that vanished falls back to all. */
export async function getViewProfiles(userId: string): Promise<Stored> {
  const stored = (await getUserSetting<Stored>(userId, KEY)) ?? { profiles: [], activeId: null };
  const owned = new Set(
    (await prisma.workspace.findMany({ where: { ownerId: userId }, select: { id: true } })).map((workspace) => workspace.id),
  );
  const profiles = stored.profiles.map((profile) => ({ ...profile, workspaceIds: profile.workspaceIds.filter((id) => owned.has(id)) }));
  const activeId = profiles.some((profile) => profile.id === stored.activeId) ? stored.activeId : null;
  return { profiles, activeId };
}

/** Workspaces the active profile shows, or null when it shows all of them. */
export async function visibleWorkspaceIds(userId: string): Promise<string[] | null> {
  const { profiles, activeId } = await getViewProfiles(userId);
  return profiles.find((profile) => profile.id === activeId)?.workspaceIds ?? null;
}

/** Prisma filter for the active profile ({} when it shows everything). */
export async function visibleWorkspaceFilter(userId: string) {
  const ids = await visibleWorkspaceIds(userId);
  return ids ? { id: { in: ids } } : {};
}

/** Replaces the list of profiles (new ones come without id); the active one is kept when it still exists. */
export async function saveViewProfiles(userId: string, input: { id?: string | null; name: string; workspaceIds: string[] }[]) {
  const names = new Set<string>();
  const owned = new Set(
    (await prisma.workspace.findMany({ where: { ownerId: userId }, select: { id: true } })).map((workspace) => workspace.id),
  );
  const profiles = input.map((entry) => {
    const name = entry.name.trim();
    if (!name) throw new HttpError(400, 'Dê um nome a cada perfil.');
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Já existe um perfil chamado "${name}".`);
    names.add(name.toLowerCase());
    const workspaceIds = [...new Set(entry.workspaceIds)];
    if (workspaceIds.length === 0) throw new HttpError(400, `Escolha ao menos um workspace para "${name}".`);
    if (workspaceIds.some((id) => !owned.has(id))) throw new HttpError(404, 'Workspace não encontrado.');
    return { id: entry.id || randomUUID(), name, workspaceIds };
  });
  const current = await getViewProfiles(userId);
  const activeId = profiles.some((profile) => profile.id === current.activeId) ? current.activeId : null;
  await setUserSetting(userId, KEY, { profiles, activeId });
  return viewProfilesResponse(userId);
}

export async function setActiveViewProfile(userId: string, id: string | null) {
  const current = await getViewProfiles(userId);
  if (id && !current.profiles.some((profile) => profile.id === id)) throw new HttpError(404, 'Perfil não encontrado.');
  await setUserSetting(userId, KEY, { ...current, activeId: id });
  return viewProfilesResponse(userId);
}

/** Profiles, the active one, and how many executions wait for an answer in workspaces the profile hides. */
export async function viewProfilesResponse(userId: string) {
  const { profiles, activeId } = await getViewProfiles(userId);
  const visible = profiles.find((profile) => profile.id === activeId)?.workspaceIds ?? null;
  const hiddenWaiting = visible
    ? await prisma.agent.count({ where: { kind: 'TASK', status: 'WAITING_INPUT', workspace: { ownerId: userId, id: { notIn: visible } } } })
    : 0;
  return { profiles, activeId, hiddenWaiting };
}
