import { buildApp } from './app.js';
import { config } from './config.js';
import { startAgentMonitor } from './modules/agents/monitor.js';
import { failInterruptedPreparations, resumeFinalizing, startPreparedAgents } from './modules/agents/service.js';
import { startTestServicesJanitor } from './modules/agents/test-services.js';
import { startCapacityMonitor } from './modules/capacity/service.js';
import { startAutoAnswer } from './modules/auto-answer/service.js';
import { startPlanLimitResume } from './modules/plan-limit/service.js';
import { startCopyCleanup } from './modules/agents/cleanup.js';
import { startSeedCapture } from './modules/agents/build-dirs.js';
import { startBoardWatch } from './modules/board-watch/service.js';
import { startWebhookUpkeep } from './modules/webhooks/hooks.js';
import { startOrbiRoutines } from './modules/orbi/routines.js';
import { startDiskMaintenance } from './modules/system/maintenance.js';
import { startDockerSweep } from './modules/system/sweep.js';
import { startCompactionWatch } from './modules/system/compaction.js';
import { startTestEnvMonitor } from './modules/test-envs/service.js';
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
// Installed dependencies of finished copies are kept per project and lockfile, so new copies start with them.
const stopSeedCapture = startSeedCapture(app.log);
// Tasks left stuck on the board (no agent, no run, no reason to wait) are found and sorted out.
const stopBoardWatch = startBoardWatch(app.log);
app.addHook('onClose', async () => stopBoardWatch());
// Git webhooks: the hooks of the linked boards are checked again every few hours.
const stopWebhookUpkeep = startWebhookUpkeep(app.log);
app.addHook('onClose', async () => stopWebhookUpkeep());
// Órbi's pilot mode: when it is on, Órbi deals with agent questions, failed runs and capacity suggestions by itself.
const stopOrbiRoutines = startOrbiRoutines(app.log);
app.addHook('onClose', async () => stopOrbiRoutines());
// Docker disk upkeep: build cache and orphan images deleted and free space trimmed, daily (sooner when the disk is short).
const stopDiskMaintenance = startDiskMaintenance(app.log);
const stopDockerSweep = startDockerSweep(app.log);
app.addHook('onClose', async () => {
  stopDiskMaintenance();
  stopDockerSweep();
});
// Back from a disk compaction (the Windows helper stopped and restarted Docker): resumes what was paused for it.
const stopCompactionWatch = startCompactionWatch(app.log);
app.addHook('onClose', async () => stopCompactionWatch());
// Test environments: queued ones start when the computer has room; finished agents' ones are taken down.
const stopTestEnvMonitor = startTestEnvMonitor(app.log);
app.addHook('onClose', async () => stopTestEnvMonitor());
app.addHook('onClose', async () => stopSeedCapture());

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
