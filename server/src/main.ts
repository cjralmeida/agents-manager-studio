import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
