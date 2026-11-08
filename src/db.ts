import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  kind: 'postgres' | 'pglite';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(options: { url?: string; dataDir?: string } = {}): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10, connectionTimeoutMillis: 10000 });
    return {
      kind: 'postgres',
      async query<T extends Row>(sql: string, params?: unknown[]) { return pool.query<T>(sql, params); },
      async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '10s'");
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); },
    };
  }
  const dataDir = options.dataDir ?? 'memory://';
  if (dataDir !== 'memory://') await mkdir(resolve(dataDir), { recursive: true });
  const embedded = await PGlite.create(dataDir);
  return {
    kind: 'pglite',
    async query<T extends Row>(sql: string, params?: unknown[]) { return embedded.query<T>(sql, params); },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return embedded.transaction(async (tx) => fn({
        async query<R extends Row>(sql: string, params?: unknown[]) { return tx.query<R>(sql, params); },
      }));
    },
    async close() { await embedded.close(); },
  };
}

export async function migrate(db: Database) {
  const directory = resolve('migrations');
  await db.transaction(async (tx) => {
    if (db.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(73081221)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())');
    const applied = new Set((await tx.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue;
      const contents = await readFile(resolve(directory, name), 'utf8');
      // Migrations contain DDL only; splitting keeps both PostgreSQL drivers on the same interface.
      for (const statement of contents.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  });
}
