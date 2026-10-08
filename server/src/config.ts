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
  // Folder with one isolated clone per agent: inside this container and the same folder on the host.
  AGENTS_DIR: z.string().min(1).default('/data/agents'),
  AGENTS_HOST_DIR: z.string().min(1),
  // Host path of the skills folder, mounted into agent containers.
  CLAUDE_SKILLS_HOST_DIR: z.string().min(1),
  // Docker network shared with the server, so agent containers can reach it.
  AGENT_NETWORK: z.string().min(1).default('agents-manager-studio_default'),
  SERVER_INTERNAL_URL: z.url().default('http://server:3000'),
  // An agent container waiting for the user stops after this long without activity.
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Launching an agent asks for confirmation when Docker usage is at or above these percentages.
  AGENT_LAUNCH_MEMORY_PERCENT: z.coerce.number().min(1).max(100).default(80),
  AGENT_LAUNCH_CPU_PERCENT: z.coerce.number().min(1).max(100).default(85),
  // Sentinels stop launching agents while the Claude 5-hour window is at or above this percentage.
  SENTINEL_PLAN_LIMIT_PERCENT: z.coerce.number().min(1).max(100).default(80),
  // Render API base; overridable to point tests at a fake server.
  RENDER_API_URL: z.url().default('https://api.render.com/v1'),
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
    agentsDir: env.AGENTS_DIR,
    // Docker on Windows accepts "D:/path" binds; backslashes are normalized.
    agentsHostDir: env.AGENTS_HOST_DIR.replaceAll('\\', '/'),
    skillsHostDir: env.CLAUDE_SKILLS_HOST_DIR.replaceAll('\\', '/'),
    agentNetwork: env.AGENT_NETWORK,
    serverInternalUrl: env.SERVER_INTERNAL_URL,
    agentIdleTimeoutMs: env.AGENT_IDLE_TIMEOUT_MS,
    launchMemoryPercent: env.AGENT_LAUNCH_MEMORY_PERCENT,
    launchCpuPercent: env.AGENT_LAUNCH_CPU_PERCENT,
    sentinelPlanLimitPercent: env.SENTINEL_PLAN_LIMIT_PERCENT,
    renderApiUrl: env.RENDER_API_URL.replace(/\/+$/, ''),
  };
}

export const config = loadConfig();
