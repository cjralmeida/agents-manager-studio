import { prisma } from '../../db.js';
import { secretHint } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';

/**
 * Environment variables of a project for "Rodar": the build and tests receive them, and so does the running app
 * (the container, or every service of a compose stack). Values are stored encrypted and never shown again.
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the containers need for themselves. */
const RESERVED = /^(PATH|HOME|HOSTNAME|PWD|SHLVL|CI)$/i;

export function projectVariableKeyError(key: string) {
  if (!KEY.test(key)) return 'Use letras, números e _, sem começar por número (até 128 caracteres).';
  if (RESERVED.test(key)) return `"${key}" é usada pelo próprio container.`;
  return null;
}

export async function listProjectVariables(projectId: string) {
  const variables = await prisma.projectVariable.findMany({ where: { projectId }, orderBy: { key: 'asc' } });
  return variables.map(({ key, valueHint, updatedAt }) => ({ key, valueHint, updatedAt }));
}

export async function setProjectVariable(projectId: string, key: string, value: string) {
  const error = projectVariableKeyError(key);
  if (error) throw new HttpError(400, error);
  const data = { valueEncrypted: secrets.encrypt(value), valueHint: secretHint(value) };
  await prisma.projectVariable.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, ...data }, update: data });
}

export async function deleteProjectVariable(projectId: string, key: string) {
  const deleted = await prisma.projectVariable.deleteMany({ where: { projectId, key } });
  if (deleted.count === 0) throw notFound('Variável não encontrada.');
}

/** The decrypted variables, to hand to the containers. */
export async function projectEnv(projectId: string): Promise<Record<string, string>> {
  const variables = await prisma.projectVariable.findMany({ where: { projectId } });
  return Object.fromEntries(variables.map((variable) => [variable.key, secrets.decrypt(variable.valueEncrypted)]));
}

/**
 * A dotenv file docker compose reads (env_file and --env-file). Single quotes keep the value literal (no "$"
 * interpolation); a value with a quote or a line break goes in double quotes with escapes.
 */
export function renderDotenv(env: Record<string, string>) {
  const quote = (value: string) =>
    /['\n\r]/.test(value)
      ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('$', () => '$$')}"`
      : `'${value}'`;
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join('\n')}\n`;
}
