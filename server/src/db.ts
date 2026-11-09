import pg from 'pg';

export type Db = pg.Pool;

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', () => {
    /* conexões ociosas com erro são descartadas pelo pool */
  });
  return pool;
}
