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
  // New agent copies live in this Docker volume (fast: no Windows bridge); AGENTS_DIR keeps the code mirror for Windows.
  AGENTS_VOLUME: z.string().min(1).default('ams-agents'),
  AGENTS_VOLUME_DIR: z.string().min(1).default('/data/agents-vol'),
  // The same volume as the Docker daemon sees it (binds of preview builds run by docker compose use this path).
  AGENTS_VOLUME_DAEMON_DIR: z.string().min(1).default('/var/lib/docker/volumes/ams-agents/_data'),
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
  /** Agent containers running at once (task agents; Órbi conversations are light and not counted). */
  MAX_RUNNING_AGENTS: z.coerce.number().int().min(1).max(50).default(6),
  /** Test runner workers per agent (Vitest): each container sees every core, and one per core saturates the machine. */
  AGENT_TEST_WORKERS: z.coerce.number().int().min(1).max(16).default(2),
  // No agent starts while the disk of the agent copies has less free space than this (GB); old copies are cleaned then.
  AGENT_MIN_FREE_DISK_GB: z.coerce.number().min(0).default(10),
  // The copy of a finished agent is deleted after this many hours (completed) or days (failed or cancelled).
  AGENT_COPY_RETENTION_HOURS: z.coerce.number().min(0).default(24),
  AGENT_FAILED_COPY_RETENTION_DAYS: z.coerce.number().min(0).default(7),
  // Workflows stop starting agents while the Claude 5-hour window is at or above this percentage.
  WORKFLOW_PLAN_LIMIT_PERCENT: z.coerce.number().min(1).max(100).default(80),
  // Pace: new work waits while the 5-hour window is spent faster than the clock, so the plan lasts until the reset.
  WORKFLOW_PLAN_PACE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Share of the 5-hour window the pace keeps for the user (agents only use the rest).
  WORKFLOW_PLAN_RESERVE_PERCENT: z.coerce.number().min(0).max(90).default(0),
  // Folder shared with the Windows helper (studio.ps1): requests in, heartbeat and results out.
  HOST_HELPER_DIR: z.string().min(1).default('/data/host-helper'),
  // Where agent containers reach the throwaway test services (compose service names).
  TEST_DATABASE_HOST: z.string().min(1).default('postgres'),
  TEST_REDIS_HOST: z.string().min(1).default('redis'),
  // Marks the session cookie Secure; set to true when the Studio is served over https.
  COOKIE_SECURE: z.stringbool().default(false),
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
    agentsVolume: env.AGENTS_VOLUME,
    agentsVolumeDir: env.AGENTS_VOLUME_DIR,
    agentsVolumeDaemonDir: env.AGENTS_VOLUME_DAEMON_DIR,
    // Docker on Windows accepts "D:/path" binds; backslashes are normalized.
    agentsHostDir: env.AGENTS_HOST_DIR.replaceAll('\\', '/'),
    skillsHostDir: env.CLAUDE_SKILLS_HOST_DIR.replaceAll('\\', '/'),
    agentNetwork: env.AGENT_NETWORK,
    serverInternalUrl: env.SERVER_INTERNAL_URL,
    agentIdleTimeoutMs: env.AGENT_IDLE_TIMEOUT_MS,
    launchMemoryPercent: env.AGENT_LAUNCH_MEMORY_PERCENT,
    launchCpuPercent: env.AGENT_LAUNCH_CPU_PERCENT,
    maxRunningAgents: env.MAX_RUNNING_AGENTS,
    agentTestWorkers: env.AGENT_TEST_WORKERS,
    minFreeDiskGb: env.AGENT_MIN_FREE_DISK_GB,
    copyRetentionHours: env.AGENT_COPY_RETENTION_HOURS,
    failedCopyRetentionDays: env.AGENT_FAILED_COPY_RETENTION_DAYS,
    workflowPlanLimitPercent: env.WORKFLOW_PLAN_LIMIT_PERCENT,
    workflowPlanPace: env.WORKFLOW_PLAN_PACE,
    workflowPlanReservePercent: env.WORKFLOW_PLAN_RESERVE_PERCENT,
    hostHelperDir: env.HOST_HELPER_DIR,
    cookieSecure: env.COOKIE_SECURE,
    testDatabaseHost: env.TEST_DATABASE_HOST,
    testRedisHost: env.TEST_REDIS_HOST,
    renderApiUrl: env.RENDER_API_URL.replace(/\/+$/, ''),
  };
}

export const config = loadConfig();
