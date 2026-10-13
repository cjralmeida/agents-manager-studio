import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { renderEnvFile, variableKeyError } from './env-file.js';

/** UID/GID of the "node" user that runs inside agent containers. */
const AGENT_UID = '1000:1000';
/** Where each agent's variables file lives (outside its repository copy), mounted read-only at /run/studio. */
const VARS_DIR = '.studio-vars';
export const AGENT_VARIABLES_FILE = '/run/studio/variables.env';

function variablesDir(agentId: string) {
  return path.posix.join(config.agentsDir, VARS_DIR, agentId);
}

export function variablesHostDir(agentId: string) {
  return `${config.agentsHostDir}/${VARS_DIR}/${agentId}`;
}

export async function listAgentVariables(workspaceId: string) {
  const variables = await prisma.agentVariable.findMany({ where: { workspaceId }, orderBy: { key: 'asc' } });
  return variables.map(({ key, valueHint, updatedAt }) => ({ key, valueHint, updatedAt }));
}

export async function setAgentVariable(workspaceId: string, key: string, value: string) {
  const error = variableKeyError(key);
  if (error) throw new HttpError(400, error);
  const data = { valueEncrypted: secrets.encrypt(value), valueHint: secretHint(value) };
  await prisma.agentVariable.upsert({
    where: { workspaceId_key: { workspaceId, key } },
    create: { workspaceId, key, ...data },
    update: data,
  });
  await refreshRunningAgents(workspaceId);
  return listAgentVariables(workspaceId);
}

export async function deleteAgentVariable(workspaceId: string, key: string) {
  const deleted = await prisma.agentVariable.deleteMany({ where: { workspaceId, key } });
  if (deleted.count === 0) throw notFound('Variável não encontrada.');
  await refreshRunningAgents(workspaceId);
  return listAgentVariables(workspaceId);
}

/** Writes the agent's variables file (readable only by the agent user); returns the names it holds. */
export async function writeAgentVariables(agent: { id: string; workspaceId: string }) {
  const variables = await prisma.agentVariable.findMany({ where: { workspaceId: agent.workspaceId }, orderBy: { key: 'asc' } });
  const dir = variablesDir(agent.id);
  const file = path.posix.join(dir, 'variables.env');
  const json = path.posix.join(dir, 'variables.json');
  const entries = variables.map((variable) => ({ key: variable.key, value: secrets.decrypt(variable.valueEncrypted) }));
  await mkdir(dir, { recursive: true });
  // The .env is shell syntax (values quoted); code that reads the file itself takes the JSON, with the plain values.
  await writeFile(file, renderEnvFile(entries));
  await writeFile(json, JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])), null, 2));
  await chmod(dir, 0o700);
  await chmod(file, 0o600);
  await chmod(json, 0o600);
  await new Promise<void>((resolve) => execFile('chown', ['-R', AGENT_UID, dir], () => resolve()));
  return variables.map((variable) => variable.key);
}

export async function removeAgentVariables(agentId: string) {
  await rm(variablesDir(agentId), { recursive: true, force: true });
}

/** Running agents see new or changed variables the next time they load the file (e.g. after asking the user). */
async function refreshRunningAgents(workspaceId: string) {
  const agents = await prisma.agent.findMany({ where: { workspaceId, containerId: { not: null } }, select: { id: true, workspaceId: true } });
  for (const agent of agents) await writeAgentVariables(agent).catch(() => undefined);
}
