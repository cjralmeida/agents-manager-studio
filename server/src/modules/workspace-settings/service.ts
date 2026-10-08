import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { listSkills } from '../skills/service.js';

export interface WorkspaceSettingsData {
  agentAccountId: string | null;
  /** Render account used for deploys (services per project are set apart). */
  renderAccountId: string | null;
  gitAccountIds: string[];
  enabledSkillIds: string[];
}

type Tx = Prisma.TransactionClient;

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsData> {
  await ensureWorkspacesExist([workspaceId]);
  return readSettings(prisma, workspaceId);
}

export async function updateWorkspaceSettings(workspaceId: string, input: WorkspaceSettingsData) {
  await ensureWorkspacesExist([workspaceId]);
  await validateSettings(input);
  await prisma.$transaction((tx) => writeSettings(tx, workspaceId, input));
  return readSettings(prisma, workspaceId);
}

/** Replaces the settings of each target with a copy of the source settings. */
export async function copyWorkspaceSettings(sourceId: string, targetIds: string[]) {
  const targets = [...new Set(targetIds)].filter((id) => id !== sourceId);
  await ensureWorkspacesExist([sourceId, ...targets]);

  await prisma.$transaction(async (tx) => {
    const settings = await readSettings(tx, sourceId);
    for (const targetId of targets) {
      await writeSettings(tx, targetId, settings);
    }
  });
  return { copiedTo: targets.length };
}

async function readSettings(db: Tx, workspaceId: string): Promise<WorkspaceSettingsData> {
  const [settings, links] = await Promise.all([
    db.workspaceSettings.findUnique({ where: { workspaceId } }),
    db.workspaceGitAccount.findMany({ where: { workspaceId }, select: { gitAccountId: true } }),
  ]);
  return {
    agentAccountId: settings?.agentAccountId ?? null,
    renderAccountId: settings?.renderAccountId ?? null,
    gitAccountIds: links.map((link) => link.gitAccountId),
    enabledSkillIds: settings?.enabledSkillIds ?? [],
  };
}

async function writeSettings(tx: Tx, workspaceId: string, settings: WorkspaceSettingsData) {
  const data = {
    agentAccountId: settings.agentAccountId,
    renderAccountId: settings.renderAccountId,
    enabledSkillIds: settings.enabledSkillIds,
  };
  await tx.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  await tx.workspaceGitAccount.deleteMany({ where: { workspaceId } });
  await tx.workspaceGitAccount.createMany({
    data: settings.gitAccountIds.map((gitAccountId) => ({ workspaceId, gitAccountId })),
  });
}

async function validateSettings(input: WorkspaceSettingsData) {
  if (input.agentAccountId) {
    const exists = await prisma.agentAccount.count({ where: { id: input.agentAccountId } });
    if (!exists) throw new HttpError(422, 'Conta de agente não encontrada.');
  }

  if (input.renderAccountId && !(await prisma.renderAccount.count({ where: { id: input.renderAccountId } }))) {
    throw new HttpError(422, 'Conta do Render não encontrada.');
  }

  const gitAccounts = await prisma.gitAccount.findMany({
    where: { id: { in: input.gitAccountIds } },
    select: { host: true },
  });
  if (gitAccounts.length !== new Set(input.gitAccountIds).size) {
    throw new HttpError(422, 'Uma ou mais contas git não foram encontradas.');
  }
  // Agents pick the account by the host of the project's remote, so each host can have only one account.
  const hosts = gitAccounts.map((account) => account.host);
  const duplicatedHost = hosts.find((host, index) => hosts.indexOf(host) !== index);
  if (duplicatedHost) {
    throw new HttpError(422, `Selecione só uma conta para ${duplicatedHost} neste workspace.`);
  }

  const availableSkills = new Set((await listSkills()).map((skill) => skill.id));
  const unknownSkills = input.enabledSkillIds.filter((id) => !availableSkills.has(id));
  if (unknownSkills.length > 0) {
    throw new HttpError(422, `Skills não encontradas: ${unknownSkills.join(', ')}.`);
  }
}

async function ensureWorkspacesExist(ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await prisma.workspace.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw notFound('Workspace não encontrado.');
}
