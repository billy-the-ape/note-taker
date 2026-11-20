/**
 * The postgres.js pool and the Drizzle instance the repositories take as their first argument
 * (docs/plans/mvp/MVP-04.md §5).
 *
 * Two rules:
 *
 * * **The DSN comes from `databaseUrl()` and nowhere else.** A pool that built its own connection string is
 *   how a second, quietly different database appears (plan §16).
 * * **`db` is a value, not an import-time singleton.** Every repository function takes the `Db` as its first
 *   argument, so a test can pass one pool while the app holds another, and nothing in `src/db` depends on
 *   module-level state. `getDb()` is the app-wide handle, created on first use by `index.ts`.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { databaseUrl, parseEnv } from '../env.js';
import { schema } from './schema.js';

/** Every table this application owns, typed. Repositories take this as their first parameter. */
export type Db = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  /** Overrides the DSN; defaults to `databaseUrl()`, the single resolver (plan §16). */
  readonly url?: string;
  /** Pool size; defaults to `DB_POOL_MAX` (10). `1` is what the migration runner asks for. */
  readonly max?: number;
}

/** A pool and the only way to release it. */
export interface DbHandle {
  readonly db: Db;
  /** Closes every connection. Idempotent per handle, so an `onClose` hook cannot double-close. */
  close(): Promise<void>;
}

/**
 * Opens a pool. Nothing connects yet: postgres.js is lazy, so `createDb()` is safe in a process that has a
 * database configured but not yet running (the unit tests and `pnpm build` both prove that).
 */
export function createDb(options: CreateDbOptions = {}): DbHandle {
  const url = options.url ?? databaseUrl();
  const max = options.max ?? parseEnv().DB_POOL_MAX;

  const pool = postgres(url, {
    max,
    // A self-hosted app talks to a database on the same machine or network: close connections idle for 30s,
    // and recycle anything older than an hour so a restarted `db` container is not reached through a
    // half-open socket forever.
    idle_timeout: 30,
    max_lifetime: 60 * 60,
    connect_timeout: 10,
    // This schema uses no custom types (no enum/domain/composite), so skip the per-connection
    // `SELECT typname …` that `fetch_types` would add to every new connection.
    fetch_types: false,
    // `migrateDatabase()` runs `CREATE SCHEMA IF NOT EXISTS drizzle` and friends, so on every start of an
    // existing install Postgres reports `42P06`/`42P07` notices — expected, not information. postgres.js'
    // default handler inspect-prints them straight to stdout, which would put two raw object dumps above the
    // first pino line of every container boot; structured logging is the app's job, not the driver's.
    onnotice: () => {},
  });

  let closed = false;
  return {
    db: drizzle(pool, { schema }),
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

/**
 * The `/api/health` probe: one round trip, no table touched.
 *
 * It is a function over an injected `Db` rather than a call to `getDb()` so the route module stays free of the
 * pool and a test can prove both answers — including the failing one — without stopping a database.
 */
export async function probeDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

const appHandle: { current: DbHandle | undefined } = { current: undefined };

/**
 * The process-wide pool, opened on first use.
 *
 * Deliberately not a module-level `const`: `pnpm build`, `pnpm lint` and every unit test import this file's
 * type without a database to talk to, and an import-time pool would make `databaseUrl()` a build-time
 * requirement.
 */
export function getDb(): DbHandle {
  appHandle.current ??= createDb();
  return appHandle.current;
}

/** Releases {@link getDb()}'s pool. A process that never opened one has nothing to close. */
export async function closeDb(): Promise<void> {
  const handle = appHandle.current;
  if (!handle) return;
  appHandle.current = undefined;
  await handle.close();
}
