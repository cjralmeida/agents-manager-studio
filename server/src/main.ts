import { buildApp } from './app.js';
import { config } from './config.js';
import { startAgentMonitor } from './modules/agents/monitor.js';
import { startTestServicesJanitor } from './modules/agents/test-services.js';
import { startDeploymentMonitor } from './modules/render/service.js';
import { startWorkflowScheduler } from './modules/workflows/scheduler.js';
import { scanWorkspaces } from './modules/workspaces/service.js';

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });

// Picks up folders created while the server was down; failures must not stop the server.
try {
  const summary = await scanWorkspaces();
  app.log.info({ summary }, 'Initial workspace scan completed');
} catch (err) {
  app.log.error({ err }, 'Initial workspace scan failed');
}
