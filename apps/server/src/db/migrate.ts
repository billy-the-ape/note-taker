/**
 * The programmatic migration runner (docs/plans/mvp/MVP-04.md §5).
 *
 * It is wired into `index.ts` **before `listen()`**, so a container never serves traffic against an
 * unmigrated schema — plan §6: "migrations run at container start before `listen()`", and PR-18's container
 * entrypoint is only `exec node dist/index.js`, with no `db:migrate` step in front of it.
 *
 * Two entry points, one implementation:
 *
 * * `pnpm db:migrate` (drizzle-kit) for a human at a shell, and
 * * `migrateDatabase()` here for the app and for `migrate.int.test.ts`.
 *
 * Both are **idempotent**: drizzle-kit records what it applied in `drizzle.__drizzle_migrations`, so running
 * the runner twice on the same database applies the pending migrations the first time and nothing the second.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Logger } from 'pino';

import { databaseUrl } from '../env.js';
import { createDb, type Db } from './client.js';

export interface MigrateOptions {
  /** Use an existing pool (the app does). Otherwise a one-connection pool is opened and closed here. */
  readonly db?: Db;
  /** DSN for that pool; defaults to `databaseUrl()`. Ignored when `db` is supplied. */
  readonly url?: string;
  /** Migrations folder; defaults to the `migrations/` next to this package. */
  readonly folder?: string;
  /** Where to report what happened. Boot logging passes the Fastify logger. */
  readonly log?: Logger;
}

export interface MigrateResult {
  /** Migrations present on disk. */
  readonly total: number;
  /** Migrations this call actually applied — `0` is what "already up to date" looks like. */
  readonly applied: number;
  readonly folder: string;
}

/**
 * The committed SQL this package ships: the nearest `package.json` at or above `startDir`, plus
 * `migrations/`.
 *
 * A literal `'../migrations'` is wrong the moment the file is compiled — `src/db/migrate.ts` sits beside
 * `apps/server/`, while `dist/db/migrate.js` would resolve it to `apps/server/dist/migrations`. Walking up to
 * the package root is the one expression that is true under `tsx`, under `node dist/…`, and under Vitest.
 */
export function migrationsDir(startDir: string = import.meta.dirname): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `cannot locate this package's root: no package.json at or above ${startDir} ` +
          '(migrateDatabase() finds apps/server/migrations through it)',
      );
    }
    dir = parent;
  }
  return path.join(dir, 'migrations');
}

/**
 * How many migrations the database already has.
 *
 * `0` on any failure, including "the `drizzle` schema does not exist yet", which is exactly the state of a
 * fresh database — and reporting that as `0` is what makes `applied` mean something.
 */
async function countApplied(db: Db): Promise<number> {
  try {
    const result = await db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
    // postgres.js hands back the rows themselves; a session that wraps them (`{ rows }`) is tolerated so
    // this stays a fact about the database rather than a fact about the driver.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown }).rows ?? []);
    const first = (rows as readonly unknown[])[0] as { count?: unknown } | undefined;
    const count = first?.count;
    return typeof count === 'number' ? count : Number(count ?? 0);
  } catch {
    return 0;
  }
}

async function apply(db: Db, folder: string, total: number, log?: Logger): Promise<MigrateResult> {
  const before = await countApplied(db);
  await migrate(db, { migrationsFolder: folder });
  const applied = (await countApplied(db)) - before;

  log?.info(
    { migrations: { total, applied, folder } },
    applied === 0 ? 'database schema already up to date' : 'database migrations applied',
  );
  return { total, applied, folder };
}

/**
 * Applies every pending migration in `folder`.
 *
 * @throws if the folder is missing (an image built without `migrations/`, or `pnpm db:generate` never ran),
 *   or if any statement in any pending migration fails.
 */
export async function migrateDatabase(options: MigrateOptions = {}): Promise<MigrateResult> {
  const folder = options.folder ?? migrationsDir();
  if (!existsSync(path.join(folder, 'meta', '_journal.json'))) {
    throw new Error(
      `no migration journal in ${folder}: run \`pnpm db:generate\` (drizzle-kit generate) and commit the SQL. ` +
        'The app refuses to boot against a schema it cannot create.',
    );
  }
  // The journal is read before a single statement runs, so a truncated or hand-broken `meta/` fails here
  // rather than halfway through the first migration.
  const total = readMigrationFiles({ migrationsFolder: folder }).length;

  if (options.db) return await apply(options.db, folder, total, options.log);

  // The standalone path (a script, or a test proving idempotence): one connection, closed on every exit.
  const handle = createDb({ url: options.url ?? databaseUrl(), max: 1 });
  try {
    return await apply(handle.db, folder, total, options.log);
  } finally {
    await handle.close();
  }
}

// Note there is deliberately no `if (require.main === module)` CLI here: the shell entry point for a human is
// `pnpm db:migrate` (drizzle-kit), and the one for the app is `index.ts` calling `migrateDatabase()`. A third
// way to run the same migrations would be a third thing to keep in sync and to test.
