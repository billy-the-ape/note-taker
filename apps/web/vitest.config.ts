import { defineConfig } from 'vitest/config';

/**
 * Unit test config (docs/plans/mvp/MVP-01.md §6.5, plan §14).
 *
 * Same split rule as the server: `include` is scoped to test files under `src`, and
 * `*.int.test.ts` files are excluded, so the DB-backed files PR-04 adds can never leak into
 * `pnpm test` or into the Postgres-free `unit` CI job.
 *
 * `passWithNoTests` is set **here only**, because PR-01 deliberately ships no web tests and Vitest
 * would otherwise exit 1 with "No test files found" — which would break this PR's own acceptance
 * and PR-03's `unit` job. The server has real tests from day one, so an empty server suite stays
 * red. PR-05 drops this flag when `src/lib/api.ts` gets the first web tests.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.int.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx'],
      /**
       * No `thresholds` here, deliberately (§14): the `apps/web/src/lib` row is armed by **PR-05**
       * (the first web tests, mocked-`fetch` coverage of `lib/api.ts`) and the overall
       * `apps/web/src` row by **PR-08** (the first components). A threshold over a scope with
       * nothing in it is a guaranteed red, and thresholds only ratchet upward.
       */
    },
  },
});
