import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { containerLabels } from '../../lib/docker.js';
import { HttpError } from '../../lib/errors.js';
import { checkExcludeNames, checkProjectsDir, manualCommand, sameFolder } from './projects-root.js';

/** The helper rewrites helper.json every 2 s; older than this means it is not running. */
const HEARTBEAT_STALE_MS = 15_000;

/** Codes written by studio.ps1 (ASCII only there), shown in Portuguese. */
const RESULT_MESSAGES: Record<string, string> = {
  invalid_path: 'O caminho não é válido.',
  system_folder: 'Escolha uma pasta de projetos, não uma pasta do sistema.',
  not_found: 'A pasta não existe no Windows. Crie a pasta e tente de novo.',
  env_missing: 'O arquivo .env do Studio não foi encontrado.',
};

interface HelperState {
  pid: number;
  dev: boolean;
  heartbeatAt: string;
}

interface HelperResult {
  id: string;
  status: 'applying' | 'done' | 'error';
  code: string | null;
  at: string;
}

export async function readJson<T>(name: string): Promise<T | null> {
  try {
    const text = await readFile(path.join(config.hostHelperDir, name), 'utf8');
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

/** Writes through a temp file so the helper never reads half a request. */
export async function writeJson(name: string, value: unknown) {
  await mkdir(config.hostHelperDir, { recursive: true });
  const target = path.join(config.hostHelperDir, name);
  await writeFile(`${target}.tmp`, JSON.stringify(value), 'utf8');
  await rename(`${target}.tmp`, target);
}

/** Studio folder on Windows, from the compose labels of this container (null when unknown). */
async function studioDir() {
  const labels = await containerLabels(os.hostname()).catch(() => null);
  return labels?.['com.docker.compose.project.working_dir'] ?? null;
}

export async function getHostHelper() {
  const [state, result, dir] = await Promise.all([readJson<HelperState>('helper.json'), readJson<HelperResult>('result.json'), studioDir()]);
  const online = state ? Date.now() - new Date(state.heartbeatAt).getTime() < HEARTBEAT_STALE_MS : false;
  const script = dir ? `'${dir.replaceAll("'", "''")}\\studio.ps1'` : '.\\studio.ps1';
  return {
    online,
    studioDir: dir,
    installCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -Install${config.isDev ? ' -Dev' : ''}`,
    lastResult: result && {
      id: result.id,
      status: result.status,
      at: result.at,
      error: result.code ? (RESULT_MESSAGES[result.code] ?? `O Studio não conseguiu reiniciar: ${result.code}`) : null,
    },
  };
}

/**
 * Asks the Windows helper to switch the central folder (it updates .env and recreates the server). When the
 * helper is not running, nothing is written and the answer carries the command to run by hand.
 */
export async function requestProjectsRoot(input: { hostPath: string; excluded: string[] }) {
  const folder = checkProjectsDir(input.hostPath);
  if (folder.problem !== null) throw new HttpError(422, folder.problem);
  const exclude = checkExcludeNames(input.excluded);
  if (exclude.problem) throw new HttpError(422, exclude.problem);
  const sameExclude = exclude.names.map((name) => name.toLowerCase()).sort().join(',') === [...config.scanExclude].sort().join(',');
  if (sameFolder(folder.path, config.projectsHostDir) && sameExclude) throw new HttpError(422, 'Essa já é a pasta central.');

  const helper = await getHostHelper();
  const command = manualCommand({ studioDir: helper.studioDir, dev: config.isDev, path: folder.path, exclude: exclude.names });
  if (!helper.online) return { requestId: null, hostPath: folder.path, command };

  const requestId = randomUUID();
  await writeJson('request.json', { id: requestId, type: 'projects-root', projectsDir: folder.path, exclude: exclude.names, createdAt: new Date().toISOString() });
  return { requestId, hostPath: folder.path, command };
}
