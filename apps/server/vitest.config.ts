import { defineConfig } from 'vitest/config';

/**
 * Unit test config (docs/plans/mvp/MVP-01.md §6.5, plan §14).
 *
 * The split rule lives here so PR-04 never has to edit this file: `include` is scoped to test files
 * under `src`, and `*.int.test.ts` files are excluded, because Vitest's default include
 * (`*.{test,spec}.*` anywhere) would otherwise collect the DB-backed files PR-04 adds into
 * `pnpm test` and into the Postgres-free `unit` CI job.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.int.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The bootstrap is exercised by the acceptance checks (a real `listen()`), not by unit tests,
      // and generated/typed route files arrive in later PRs.
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      /**
       * No `thresholds` yet, deliberately: §14's server rows are `src/{crypto,domain}` (armed by
       * PR-06, which creates those directories) and `src/{services,db,routes}` (armed by PR-04 in
       * `vitest.integration.config.ts`, the only config with a Postgres service). A threshold over
       * a scope with nothing in it is a guaranteed red, and thresholds only ever ratchet upward —
       * so the first PR that can pass a row is the PR that sets it.
       */
    },
  },
});
