import { execFile } from 'node:child_process';

export class GitError extends Error {
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    this.stderr = stderr;
  }
}

/**
 * Runs git and returns stdout. Repositories on Windows mounts are owned by another user,
 * so `safe.directory` is relaxed; the args must never contain secrets that could be logged.
 */
export function git(cwd: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
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
