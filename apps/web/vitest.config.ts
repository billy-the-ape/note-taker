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
 * The environment stays `node`, and that is not an oversight now that components exist: PR-16's
 * component tests opt into jsdom per file with the `// @vitest-environment jsdom` docblock, so the
 * transport suite PR-05 wrote — which proves `lib/api.ts` needs no `document` to read a CSRF cookie
 * — keeps proving it in an environment that has no `document`.
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
      // `src/test/**` is the same argument the server config makes: the fakes the suite runs on
      // (a session-accurate fake API, a `matchMedia` that can be driven, PR-14's editor stand-in)
      // are the instruments, not the specimen, and reporting them at 0% next to the code they
      // measure would describe the wrong thing.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/routeTree.gen.ts', 'src/main.tsx'],
      /**
       * The `apps/web/src/lib` row of plan §14, armed by PR-05 (80 lines / 80 functions / 75 branches
       * / 80 statements). Written as a glob rather than a global threshold because §14's rows are
       * armed one at a time, by the PR whose files first give a scope something to measure: a
       * threshold over a scope with nothing in it is a guaranteed red, and thresholds only ratchet
       * upward.
       *
       * The `'**'` row is §14's overall `apps/web/src` row (55/55/50/55), armed here by PR-16 because
       * PR-16 is the first PR with component files a Postgres-free web suite can reach: PR-08 (its
       * nominal owner) has not merged, so nothing under `components/ui`, `features/auth` or the app
       * shell exists to be measured, and the first screen that does exist is `/app/settings`. It is
       * written as a glob key alongside PR-05's so `src/lib` keeps its own, higher bar rather than
       * being averaged down by the new screen — and, as the server config says of its own glob keys,
       * a key here is read and not decorative: raise `'**'` to `99.5` and the job fails with
       * `does not meet "**" threshold (99.5%)`.
       */
      thresholds: {
        '**': { lines: 55, functions: 55, branches: 50, statements: 55 },
        'src/lib/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
      },
    },
  },
});
