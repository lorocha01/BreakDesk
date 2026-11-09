import pg from 'pg';

/** Interface mínima de banco usada pelo servidor (compatível com pg.Pool). */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}
export interface DbClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<DbClient>;
  end(): Promise<void>;
}

/**
 * `DATABASE_URL`:
 *  - `postgres://...`   → PostgreSQL (produção)
 *  - `pglite:<pasta>`   → PostgreSQL embutido (WebAssembly) gravando em <pasta>; sem instalação,
 *                         ideal para testes locais e para o pacote "servidor Windows".
 */
export function createDb(url: string): Db {
  if (url.startsWith('pglite:')) return createPglite(url.slice('pglite:'.length) || './dados');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', () => {
    /* conexões ociosas com erro são descartadas pelo pool */
  });
  return pool as unknown as Db;
}

/** PGlite devolve bytea como Uint8Array; o código espera Buffer (como o driver pg). */
function normalizeRows<T>(rows: any[]): T[] {
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) r[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    }
  }
  return rows as T[];
}

function createPglite(dir: string): Db {
  // Import dinâmico: a dependência só é carregada no modo embutido.
  const ready = import('@electric-sql/pglite').then(({ PGlite }) => PGlite.create(dir));
  // PGlite é single-connection: serializa as operações numa fila.
  let chain: Promise<unknown> = Promise.resolve();
  const run = <R>(fn: (db: any) => Promise<R>): Promise<R> => {
    const p = chain.then(() => ready.then(fn));
    chain = p.catch(() => {});
    return p;
  };
  const exec = async <T>(db: any, sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    if (params && params.length) {
      const args = params.map((p) => (Buffer.isBuffer(p) ? new Uint8Array(p) : p));
      const r = await db.query(sql, args);
      return { rows: normalizeRows<T>(r.rows), rowCount: r.rows.length || r.affectedRows || 0 };
    }
    // Sem parâmetros: permite vários comandos (migrações).
    const results = await db.exec(sql);
    const last = results[results.length - 1] ?? { rows: [] };
    return { rows: normalizeRows<T>(last.rows), rowCount: last.rows.length || last.affectedRows || 0 };
  };
  return {
    query: (sql, params) => run((db) => exec(db, sql, params)),
    // Um "cliente" dedicado segura a fila até release() — necessário para transações.
    connect: async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let acquired!: (db: any) => void;
      const got = new Promise<any>((r) => (acquired = r));
      const p = chain.then(() => ready.then((db) => (acquired(db), held)));
      chain = p.catch(() => {});
      const db = await got;
      return { query: (sql, params) => exec(db, sql, params), release };
    },
    end: () => run((db) => db.close()),
  };
}
