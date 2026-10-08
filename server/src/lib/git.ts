import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class GitError extends Error {
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    this.stderr = stderr;
  }
}

/**
 * Global git config of the Studio: repositories on Windows mounts and agent copies are owned by other
 * users, so `safe.directory` is relaxed. It must be global config: the upload-pack process of a
 * `file://` clone (an agent continuing another agent's copy) ignores `-c` and environment overrides.
 */
const GLOBAL_CONFIG = path.join(os.tmpdir(), 'agents-manager-studio.gitconfig');
writeFileSync(GLOBAL_CONFIG, '[safe]\n\tdirectory = *\n[core]\n\tquotepath = off\n');

/** Runs git and returns stdout. The args must never contain secrets that could be logged. */
export function git(cwd: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: GLOBAL_CONFIG, ...options.env },
        maxBuffer: 50 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr || error.message));
        else resolve(stdout);
      },
    );
  });
}
