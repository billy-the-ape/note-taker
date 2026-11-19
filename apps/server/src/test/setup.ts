/**
 * The Vitest **integration** setup file (`vitest.integration.config.ts`'s `setupFiles`), i.e. the only place
 * the test suite touches a real database (docs/plans/mvp/MVP-04.md §5).
 *
 * It does three things, and the order is the point:
 *
 * 1. `loadDevEnvFile()` — Vitest does not import `src/env.ts` on its own, so without this call the suite would
 *    build a DSN from whatever the shell happened to export and ignore an edited repo-root `.env`. It is a
 *    no-op unless the **process** `NODE_ENV` is `development`/`test`, which is what
 *    `NODE_ENV=test vitest run --config vitest.integration.config.ts` supplies on its own command line.
 * 2. `parseEnv()` + `databaseUrl()` — fail fast, with the readable `EnvError` list, before a single test
 *    file is loaded. `parseEnv()` here also pins the mode: this suite must never run against a production
 *    configuration, because `resetDb()` between tests truncates everything.
 * 3. `migrateDatabase()` — idempotent, so the suite works against the throwaway Postgres a CI service
 *    publishes (empty database) and against a developer's already-migrated dev database. Without it,
 *    `pnpm test:integration` would need a `pnpm db:migrate` step in front of it in every environment.
 *
 * `afterAll` closes the pool the helpers opened, per test file.
 */
import { afterAll } from 'vitest';
import { migrateDatabase } from '../db/migrate.js';
import { databaseUrl, loadDevEnvFile, parseEnv } from '../env.js';
import { closeTestDb } from './helpers/db.js';

loadDevEnvFile();

const env = parseEnv();
if (env.NODE_ENV !== 'test') {
  throw new Error(
    `the integration suite needs NODE_ENV=test (it truncates the database it is pointed at); ` +
      `got ${env.NODE_ENV}. Run it through pnpm test:integration, which declares the mode itself.`,
  );
}

/** The DSN this run is against. Resolved once, here, so a bad configuration fails before any test loads. */
export const INTEGRATION_DATABASE_URL: string = databaseUrl();

await migrateDatabase({ url: INTEGRATION_DATABASE_URL });

afterAll(async () => {
  await closeTestDb();
});
