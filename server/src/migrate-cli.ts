import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Migrações aplicadas: ${applied.join(', ')}` : 'Banco já atualizado.');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
