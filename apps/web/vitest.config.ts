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
 * need one out of the suite. PR-16's screen tests are the files that opt in (they render through
 * `src/test/render-settings.tsx`), and PR-05's transport suite still runs where `document` does not
 * exist, so nothing about the merge weakened that.
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
       * The two rows plan §14 assigns to this app, both at the **post-PR-19 column** (docs/plans/mvp/MVP-19.md
       * §6): `src/lib/**` 85/85/85/85 and overall `src/**` 65/65/65/65.
       *
       * `src/lib/**` is PR-05's, armed at 80/80/75/80, and it is a glob key rather than a global threshold so the
       * new screen cannot average it down (and, as the server config says of its own glob keys, a key here is read
       * and not decorative: raise it to `99.5` and the job fails with
       * `does not meet "src/lib/**" threshold (99.5%)`).
       *
       * `src/**` is the overall **`apps/web/src`** row: PR-08 armed it at 55/55/50/55 (docs/plans/mvp/MVP-08.md
       * §7) precisely so the six UI PRs could raise it, and PR-19 raises it to 65 on the strength of what they
       * shipped. Both PR-08 (its owner, and the one that armed it first) and PR-16 — which armed the same row
       * independently while PR-08 was still open — wrote a key for it, so the raw merge carried **two** keys for
       * one scope (`'**'` and `'src/**'`); this is the single row the plan has. It stays a glob threshold so it
       * lives here rather than in CI flags (plan §14), and §14's rule is that the PR with the tests to spare
       * raises the bar — which is the one thing PR-19 is *not* able to do for this scope from a bare clone: the
       * Playwright suite is excluded from Vitest's glob, so these two numbers are the unit suite's, measured on
       * the merged PR-08…PR-18 tree, and the ratchet to 65 is only honest because that tree is what `main` is
       * now. If a later PR finds 65 is more than its own components can carry, the fix is more component tests
       * in that PR, never a lower number here.
       */
      thresholds: {
        'src/lib/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
        'src/**': { lines: 65, functions: 65, branches: 65, statements: 65 },
      },
      // `src/test/**` is the same argument the server config makes: the fakes the suite runs on (a
      // session-accurate fake API, a `matchMedia` that can be driven, PR-14's editor stand-in) are the
      // instruments, not the specimen, and reporting them at 0% next to the code they measure would
      // describe the wrong thing.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx', 'src/test/**'],
    },
  },
});
