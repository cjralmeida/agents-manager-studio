import { z } from 'zod';

const commaSeparated = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  // Projects root as seen inside the container, and the same folder on the host machine.
  PROJECTS_DIR: z.string().min(1).default('/data/Projetos'),
  PROJECTS_HOST_DIR: z.string().min(1),
  // Top-level folders that must not become workspaces (case-insensitive).
  SCAN_EXCLUDE: commaSeparated,
  // Key for tokens stored in the database (32 bytes in hex). Changing it makes saved tokens unreadable.
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  // Claude skills folder (~/.claude/skills), mounted read-only.
  SKILLS_DIR: z.string().min(1).default('/data/claude-skills'),
  // Image used for agent containers and account checks.
  AGENT_RUNNER_IMAGE: z.string().min(1).default('agents-manager-studio-agent-runner:latest'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only variable names are reported: values may be secrets.
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`);
  }

  const env = parsed.data;
  return {
    isDev: env.NODE_ENV === 'development',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    projectsDir: env.PROJECTS_DIR,
    projectsHostDir: env.PROJECTS_HOST_DIR,
    scanExclude: env.SCAN_EXCLUDE.map((name) => name.toLowerCase()),
    encryptionKey: env.ENCRYPTION_KEY,
    skillsDir: env.SKILLS_DIR,
    agentRunnerImage: env.AGENT_RUNNER_IMAGE,
  };
}

export const config = loadConfig();
