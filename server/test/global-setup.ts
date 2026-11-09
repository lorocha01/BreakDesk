import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Usa DATABASE_URL (CI) ou sobe um cluster descartável via scripts/test-db.sh. */
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const out = execFileSync(path.join(here, '..', 'scripts', 'test-db.sh'), ['start'], { encoding: 'utf8' });
    process.env.DATABASE_URL = out.trim().split('\n').pop()!;
  }
  const db = createDb(process.env.DATABASE_URL);
  try {
    await migrate(db);
    await db.query('TRUNCATE audit_log, sessions, devices, users RESTART IDENTITY CASCADE');
  } finally {
    await db.end();
  }
}
