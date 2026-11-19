/**
 * The integration database fixture (docs/plans/mvp/MVP-04.md §5).
 *
 * * One pool per test file, opened against the DSN `src/test/setup.ts` resolved — `databaseUrl()`, the same
 *   resolver the app uses, so `.env` and CI's exported `DATABASE_URL` behave identically here.
 * * **Truncate-all between tests**, in dependency-safe order (children first), which is what lets the suite
 *   stay deterministic without a per-user seed: every test starts from an empty database and creates exactly
 *   the rows it names.
 * * The trade-off is spelled out by `fileParallelism: false` in `vitest.integration.config.ts`: one database,
 *   truncated underneath everything, so the test *files* may not run concurrently either. (PR-09's services
 *   get their concurrency from a per-user advisory lock inside one test, not from parallel files.)
 */
import { type SQL, sql } from 'drizzle-orm';

import { createDb, type Db, type DbHandle } from '../../db/client.js';
import { databaseUrl } from '../../env.js';

/**
 * Children before parents, so no `CASCADE` is needed and the statement itself documents the tree:
 * `auth_attempts` and `sessions` hang off `users`; `notes` and `folders` hang off each other and `users`;
 * `settings` is the one-to-one of `users`.
 */
const TRUNCATE_IN_ORDER = ['auth_attempts', 'sessions', 'notes', 'folders', 'settings', 'users'] as const;

let handle: DbHandle | undefined;

/**
 * The suite's pool. Lazily opened, because a test file that only asserts facts about SQL text (never a query)
 * should not need a listening database to be loaded.
 */
export function testDb(): Db {
  handle ??= createDb({ url: databaseUrl(), max: 2 });
  return handle.db;
}

/** Empties every table the application owns. Called from `beforeEach` in each `*.int.test.ts`. */
export async function resetDb(): Promise<void> {
  const targets = TRUNCATE_IN_ORDER.map((table) => sql.identifier(table));
  await testDb().execute(sql`truncate table ${sql.join(targets, sql`, `)} restart identity`);
}

/** Reads a scalar list out of the catalog — the shape the schema assertions compare against. */
export async function catalogRows(query: SQL): Promise<Record<string, unknown>[]> {
  const result = await testDb().execute(query);
  return (Array.isArray(result) ? result : ((result as { rows?: unknown }).rows ?? [])) as Record<
    string,
    unknown
  >[];
}

/** Releases the pool. Registered as `afterAll` by `src/test/setup.ts`. */
export async function closeTestDb(): Promise<void> {
  const open = handle;
  handle = undefined;
  if (open) await open.close();
}
