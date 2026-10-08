import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type GitProvider = 'GITHUB' | 'GITLAB' | 'OTHER';

export interface ScannedProject {
  name: string;
  isGitRepo: boolean;
  gitRemoteUrl: string | null;
  gitProvider: GitProvider | null;
}

export interface ScannedWorkspace {
  name: string;
  projects: ScannedProject[];
}

/** Reads the projects root: each folder is a workspace and each of its folders is a project. */
export async function scanProjectsRoot(rootDir: string, exclude: string[]): Promise<ScannedWorkspace[]> {
  const excluded = new Set(exclude.map((name) => name.toLowerCase()));
  const workspaceNames = (await listDirectories(rootDir)).filter((name) => !excluded.has(name.toLowerCase()));

  return Promise.all(
    workspaceNames.map(async (name) => {
      const workspaceDir = path.join(rootDir, name);
      const projectNames = await listDirectories(workspaceDir);
      const projects = await Promise.all(
        projectNames.map(async (projectName) => ({
          name: projectName,
          ...(await readGitInfo(path.join(workspaceDir, projectName))),
        })),
      );
      return { name, projects };
    }),
  );
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readGitInfo(projectDir: string): Promise<Omit<ScannedProject, 'name'>> {
  const gitPath = path.join(projectDir, '.git');
  const gitStat = await stat(gitPath).catch(() => null);
  if (!gitStat) {
    return { isGitRepo: false, gitRemoteUrl: null, gitProvider: null };
  }

  // A ".git" file (worktree/submodule) points elsewhere; the remote is left unknown.
  const gitConfig = gitStat.isDirectory()
    ? await readFile(path.join(gitPath, 'config'), 'utf8').catch(() => '')
    : '';
  const originUrl = parseOriginUrl(gitConfig);
  const gitRemoteUrl = originUrl ? stripCredentials(originUrl) : null;

  return {
    isGitRepo: true,
    gitRemoteUrl,
    gitProvider: gitRemoteUrl ? detectProvider(gitRemoteUrl) : null,
  };
}

export function parseOriginUrl(gitConfig: string): string | null {
  let inOrigin = false;
  for (const rawLine of gitConfig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const match = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/** Removes "user:token@" from http(s) remotes so secrets are never stored. */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

export function detectProvider(url: string): GitProvider {
  // Matches https://host/..., ssh://git@host/... and git@host:path.
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  if (host.includes('github')) return 'GITHUB';
  if (host.includes('gitlab')) return 'GITLAB';
  return 'OTHER';
}
