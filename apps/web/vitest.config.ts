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
 *
 * **`node` stays the default environment** (docs/plans/mvp/MVP-08.md §7). PR-05's client tests assert
 * that the wrapper never touches `document`; running them in jsdom would make that claim unfalsifiable,
 * and the honest reading of "it works without a DOM" is that it is *tested* without one. So the default
 * is `node`, and a component test opts into jsdom with a `// @vitest-environment jsdom` docblock on its
 * first line — which has the second benefit of keeping the cost of a DOM in the ~40 files that do not
 * need one out of the suite.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.int.test.ts'],
    environment: 'node',
    // Unmount React trees, clear `localStorage`, and drop the session cache between tests — see the
    // file for why each of those three leaks.
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      /**
       * The two rows plan §14 assigns to this app.
       *
       * `src/lib/**` (80/80/75/80) is PR-05's and stays where it was — a threshold is never lowered.
       *
       * `src/**` is the overall `apps/web/src` row this PR arms: **55 lines / 55 functions / 50 branches
       * / 55 statements** (docs/plans/mvp/MVP-08.md §7), which ratchets to 65 after PR-19. It is a glob
       * threshold rather than a global flag so that it lives here (plan §14: thresholds in the config,
       * never in CI flags), and it is lower than the `lib` row on purpose: PR-08 adds the first
       * components, and a number that covers routes, guards and a UI kit in one PR is a number that will
       * be raised by the next six PRs rather than lowered by this one.
       */
      thresholds: {
        'src/lib/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
        'src/**': { lines: 55, functions: 55, branches: 50, statements: 55 },
      },
      exclude: ['src/**/*.test.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx', 'src/test/**'],
    },
  },
});
