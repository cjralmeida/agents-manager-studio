import { buildApp } from './app.js';
import { config } from './config.js';
import { startAgentMonitor } from './modules/agents/monitor.js';
import { startBoardScheduler } from './modules/sentinels/scheduler.js';
import { scanWorkspaces } from './modules/workspaces/service.js';

const app = await buildApp();
const stopAgentMonitor = startAgentMonitor(app.log);
app.addHook('onClose', async () => stopAgentMonitor());
// Refreshes the task boards and runs the sentinels; they resume by themselves after a restart.
const stopBoardScheduler = startBoardScheduler(app.log);
app.addHook('onClose', async () => stopBoardScheduler());

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
