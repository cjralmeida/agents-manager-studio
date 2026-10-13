import { buildApp } from './app.js';
import { config } from './config.js';
import { startAgentMonitor } from './modules/agents/monitor.js';
import { failInterruptedPreparations, resumeFinalizing, startPreparedAgents } from './modules/agents/service.js';
import { startTestServicesJanitor } from './modules/agents/test-services.js';
import { startCapacityMonitor } from './modules/capacity/service.js';
import { startAutoAnswer } from './modules/auto-answer/service.js';
import { startPlanLimitResume } from './modules/plan-limit/service.js';
import { startCopyCleanup } from './modules/agents/cleanup.js';
import { startCopyMirror } from './modules/agents/mirror.js';
import { startPreviewMonitor } from './modules/previews/service.js';
import { startDeploymentMonitor } from './modules/render/service.js';
import { startWorkflowScheduler } from './modules/workflows/scheduler.js';
import { scanWorkspaces } from './modules/workspaces/service.js';
import { prisma } from './db.js';

async function waitForDatabase() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      if (attempt === 1) app.log.info('Waiting for the database before the startup recovery');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  app.log.warn('Database still unavailable after 2 minutes; running the startup recovery anyway');
}

const app = await buildApp();
const stopAgentMonitor = startAgentMonitor(app.log);
app.addHook('onClose', async () => stopAgentMonitor());
// Refreshes the task boards, starts workflows from board tasks and advances running workflows.
const stopWorkflowScheduler = startWorkflowScheduler(app.log);
app.addHook('onClose', async () => stopWorkflowScheduler());
// Follows Render deploys until they finish, also those started before a restart.
const stopDeploymentMonitor = startDeploymentMonitor(app.log);
app.addHook('onClose', async () => stopDeploymentMonitor());
// Drops the test databases and Redis indexes of finished agents; keeps agents out of the Studio databases.
const stopTestServicesJanitor = startTestServicesJanitor(app.log);
app.addHook('onClose', async () => stopTestServicesJanitor());
// "Rodar": checks new commits of the projects that are up and keeps their containers serving the stable version.
const stopPreviewMonitor = startPreviewMonitor(app.log);
app.addHook('onClose', async () => stopPreviewMonitor());
// Gestor de Capacidade: notices when a board workflow could run more or fewer tasks at once and suggests it.
const stopCapacityMonitor = startCapacityMonitor(app.log);
app.addHook('onClose', async () => stopCapacityMonitor());
// Automatic answers: a question left unanswered for the user's chosen time is answered with the recommended option.
const stopAutoAnswer = startAutoAnswer(app.log);
app.addHook('onClose', async () => stopAutoAnswer());
// Plan limit: agents that stopped on the Claude plan limit resume by themselves when it resets.
const stopPlanLimitResume = startPlanLimitResume(app.log);
app.addHook('onClose', async () => stopPlanLimitResume());
// Copies of finished agents are deleted after a while (sooner when the disk is short), so they do not fill the disk.
const stopCopyCleanup = startCopyCleanup(app.log);
app.addHook('onClose', async () => stopCopyCleanup());
// Code of the agent copies kept in the Docker volume is mirrored to the Windows folder when their agents stop.
const stopCopyMirror = startCopyMirror(app.log);
app.addHook('onClose', async () => stopCopyMirror());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });

// After a reboot the server may start before Postgres accepts connections; the startup recovery below needs the database.
await waitForDatabase();

// Agents whose commit, push or merge was cut by a restart finish now.
try {
  const resumed = await resumeFinalizing();
  if (resumed > 0) app.log.info({ resumed }, 'Resumed agents that were finishing');
} catch (err) {
  app.log.error({ err }, 'Resuming finishing agents failed');
}

// Agents whose copy was being prepared when the server stopped; their workflow steps start again.
try {
  const interrupted = await failInterruptedPreparations();
  if (interrupted > 0) app.log.info({ interrupted }, 'Failed agents whose preparation was interrupted');
  const prepared = await startPreparedAgents();
  if (prepared > 0) app.log.info({ prepared }, 'Started agents whose copy was ready before the restart');
} catch (err) {
  app.log.error({ err }, 'Failing interrupted preparations failed');
}

// Picks up folders created while the server was down; failures must not stop the server.
try {
  const summary = await scanWorkspaces();
  app.log.info({ summary }, 'Initial workspace scan completed');
} catch (err) {
  app.log.error({ err }, 'Initial workspace scan failed');
}
