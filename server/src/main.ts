import { buildApp } from './app.js';
import { config } from './config.js';
import { startAgentMonitor } from './modules/agents/monitor.js';
import { scanWorkspaces } from './modules/workspaces/service.js';

const app = await buildApp();
const stopAgentMonitor = startAgentMonitor(app.log);
app.addHook('onClose', async () => stopAgentMonitor());

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
