import { defineConfig } from 'vitest/config';

/**
 * Unit test config for `@note-taker/contracts` (docs/plans/mvp/MVP-05.md §10, plan §14).
 *
 * The same include/exclude rule as both apps (`*.int.test.ts` never joins `pnpm test`), kept here
 * even though contracts have no DB: the rule is one rule, applied in every config, so nothing in a
 * later PR has to remember whether this package was "the exception".
 *
 * Contract tests import their module side by side (`./names.js`, resolved to `./names.ts` by Vitest),
 * because a package cannot be the thing it tests. The dist-backed story is asserted where it is
 * actually used — by both apps, which import `@note-taker/contracts` through `exports` with no alias
 * to `src` (MVP-05 §4), and by the acceptance check that resolves the compiled entry point itself.
 *
 * The thresholds are the `packages/contracts` row of plan §14 (90 lines / 90 functions / 85 branches
 * / 90 statements, ratcheting to 95 across the board after PR-19). Pure module, no excuse — and this
 * is a `unit`-job scope because contracts need no database.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
