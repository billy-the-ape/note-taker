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
 * The thresholds are the `packages/contracts` row of plan §14, ratcheted by PR-19 to **95 across the board**
 * (docs/plans/mvp/MVP-19.md §6 — the post-PR-19 column; it was 90/90/85/90). Pure module, no excuse: this
 * package sits at 100% on all four, so the ratchet is a promise about the next file added to it rather than a
 * number the current ones are lucky to clear. This is a `unit`-job scope because contracts need no database.
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
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
