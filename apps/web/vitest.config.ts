import { defineConfig } from 'vitest/config';

/**
 * Unit test config (docs/plans/mvp/MVP-01.md §6.5, plan §14).
 *
 * Same split rule as the server: `include` is scoped to test files under `src`, and
 * `*.int.test.ts` files are excluded, so the DB-backed files PR-04 adds can never leak into
 * `pnpm test` or into the Postgres-free `unit` CI job.
 *
 * PR-05 removed PR-01's `passWithNoTests`: `src/lib/api.ts` brought the first web tests
 * (mocked-`fetch`, no DOM needed), so from here on an empty web suite is a failure rather than a
 * passing job.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.int.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx'],
      /**
       * The `apps/web/src/lib` row of plan §14, armed by PR-05 (80 lines / 80 functions / 75 branches
       * / 80 statements). A glob threshold rather than a global one, because the overall
       * `apps/web/src` row belongs to PR-08, which adds the first components — a threshold over a
       * scope with nothing in it is a guaranteed red, and thresholds only ratchet upward.
       */
      thresholds: {
        'src/lib/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
      },
    },
  },
});
