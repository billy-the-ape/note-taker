/**
 * The suite's "throwaway database", in the one operation that makes that phrase true (docs/plans/mvp/MVP-19.md §4).
 *
 * **Why the reset is a step of the suite rather than a step of CI.** The `e2e` job's `postgres:16` service is
 * empty when the job starts, but a developer's `notetaker_test` is not: the second `pnpm test:e2e` on a laptop
 * would find the first one's owner, and `/setup` closes behind its first owner (`auth.service.ts`), so
 * scenario 1 — "first run → `/setup`" — would fail on a machine that had already run the suite once. Truncating
 * per file is what the repo already does for its integration suite (`apps/server/src/test/helpers/db.ts`,
 * called from `beforeEach`), and it buys the same property here: every spec starts from an instance with no
 * owner, no folders and no notes, which is the only state in which "the tree is empty" and "this instance has
 * not been set up" mean anything.
 *
 * **Children first, so no `CASCADE` is needed** — the same order the integration helper documents:
 * `auth_attempts` and `sessions` hang off `users`, `notes`/`folders` hang off each other and `users`,
 * `settings` is the one-to-one of `users`.
 *
 * **This module is the suite's only writer, and that is the line `e2e/db.ts` holds.** Scenario 7's whole value
 * is reading a row the *application* wrote, so the reader is read-only and says so in a transaction; this file
 * is the opposite tool — a fixture, run before a scenario starts, whose statement names tables instead of
 * reading rows. `apps/web` could not borrow the server's helper either way: pnpm does not expose one
 * workspace's dependencies to another, which is also why `postgres` is a devDependency here at PR-04's pin.
 */
import postgres, { type Sql } from 'postgres';

import { DATABASE_URL } from './env';

/** The tables the application owns, in the order `apps/server/src/test/helpers/db.ts` truncates them. */
const TRUNCATE_IN_ORDER = ['auth_attempts', 'sessions', 'notes', 'folders', 'settings', 'users'] as const;

/**
 * Two statements, both written by this file rather than interpolated, which is what makes `unsafe` honest here:
 * `TRUNCATE TABLE a, b` takes identifiers, not bind parameters, and the only interpolation is a `join` over the
 * constant list above.
 */
const TRUNCATE_ALL = `TRUNCATE TABLE ${TRUNCATE_IN_ORDER.join(', ')} RESTART IDENTITY`;
const SCHEMA_APPLIED = `SELECT to_regclass('public.notes') IS NOT NULL AS applied`;

let pool: Sql | undefined;

function client(): Sql {
  // Positional connection string, the way `apps/server/src/db/client.ts` passes it: postgres.js 4.1.1 parses the
  // DSN from the first argument, and an options object with a `url` key silently keeps the default port.
  pool ??= postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  return pool;
}

/**
 * Empties the suite's database, and is a no-op on a database that has never been migrated.
 *
 * The guard matters because the suite is routinely run against a brand-new CI service container, where the
 * tables do not exist until `node apps/server/dist/index.js` applies the committed migration at boot — and
 * Playwright may start that `webServer` before or after a spec file begins. "Nothing to truncate yet" is a
 * success there, not a failure.
 */
export async function resetTestInstance(): Promise<void> {
  const client$ = client();
  const [probe] = await client$.unsafe<{ applied: boolean }[]>(SCHEMA_APPLIED);
  if (probe?.applied !== true) return;
  await client$.unsafe(TRUNCATE_ALL);
}

/** Releases the pool. Called from a spec's `afterAll` so a run does not hold a connection between files. */
export async function closeResetPool(): Promise<void> {
  const open = pool;
  pool = undefined;
  if (open !== undefined) await open.end({ timeout: 1 });
}
