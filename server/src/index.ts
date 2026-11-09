import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { startDiscovery } from './discovery.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);
if (process.env.MIGRATE_ON_START === 'true') {
  const applied = await migrate(db);
  if (applied.length) console.log(`Migrações aplicadas: ${applied.join(', ')}`);
}
const { app } = await buildApp(cfg, db);
await app.listen({ port: cfg.port, host: cfg.host });
startDiscovery(cfg.port);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ sig }, 'encerrando');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
