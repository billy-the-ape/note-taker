import { defineConfig } from 'vitest/config';

/**
 * The integration suite (docs/plans/mvp/MVP-04.md §5): `pnpm test:integration` /
 * `pnpm coverage:integration`, both of which declare `NODE_ENV=test` on their own command line.
 *
 * It is the **only** Vitest config that reads `DATABASE_URL` — directly or by letting `databaseUrl()` derive
 * it — and the only one whose files may touch a database. Unit and integration files never share a glob:
 * `vitest.config.ts` excludes every file whose name ends `.int.test.ts`, and this config includes nothing but
 * that suffix, which is what keeps the shared database from racing itself and keeps `pnpm test` and the
 * Postgres-free `unit` job green from here on.
 *
 * `src/test/setup.ts` runs first and is not optional: it calls `loadDevEnvFile()` (Vitest does not import
 * `src/env.ts` on its own), pins the mode, applies the migrations, and fails fast when no database answers.
 */
export default defineConfig({
  test: {
    name: 'server-integration',
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // **One database, truncated between tests.** Test files must therefore not overlap: file A's `resetDb()`
    // would empty the rows file B is asserting on. Concurrency inside a single test is still available, and
    // PR-09 will add cross-request concurrency on top of a per-user advisory lock.
    fileParallelism: false,
    // A pool that outlives a file keeps the worker alive; `forks` + the setup file's `afterAll` ends cleanly.
    pool: 'forks',
    testTimeout: 30_000,
    // ── the `apps/server/src/db` row of plan §14, armed by this PR (≥ 80% lines) ───────────────
    // Measured here and nowhere else: these files cannot be exercised without a database, so `pnpm coverage`
    // (the `unit` job) has no threshold over them. Only the scope this PR has tests in is included — a scope
    // with nothing in it is a guaranteed red — and PR-09 widens it to `services`/`routes` when its tests
    // arrive. Thresholds live in this file, never in a CI flag.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-integration',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/db/**/*.ts'],
      exclude: ['src/**/*.int.test.ts', 'src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
