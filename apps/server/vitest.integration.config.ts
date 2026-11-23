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
    // ── the `apps/server/src/{db,services,routes}` row of plan §14, widened by PR-09 ────────────
    // Measured here and nowhere else: these files cannot be exercised without a database, so `pnpm coverage`
    // (the `unit` job) has no threshold over them. PR-04 armed `src/db/**` alone — the only scope its tests
    // reached — and PR-09 adds the services and routes those repositories serve, which is what §8 of its brief
    // asks for at the same 80/80/75/80. A scope with nothing in it is a guaranteed red, and thresholds only ever
    // ratchet upward; §8 also says this row reaches 85 only after PR-19, so nothing here is raised past §14.
    //
    // `src/scripts/**` stays out of *this* report: the seed and the rotation script are exercised as subprocesses
    // (their own processes, where this collector cannot see them), so a 0% row there would read as "untested"
    // next to a test file that runs them repeatedly.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-integration',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/db/**/*.ts', 'src/services/**/*.ts', 'src/routes/**/*.ts'],
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
