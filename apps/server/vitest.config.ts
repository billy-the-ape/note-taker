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
      //
      // `src/test/**`, `src/scripts/**` and `*.int.test.ts` are excluded because the integration suite (PR-04)
      // is the only place they load — the rotation script cannot run without a database — so reporting them
      // here as 0% would describe a scope this config never runs. The integration config leaves
      // `src/scripts/**` out of *its* report too: that script is exercised as a subprocess (its own process,
      // where this collector cannot see it), so a 0% row there would read as "untested" next to a test file
      // that runs it eight times.
      exclude: ['src/index.ts', 'src/**/*.test.ts', 'src/**/*.int.test.ts', 'src/test/**', 'src/scripts/**'],
      /**
       * §14's `apps/server/src/{crypto,domain}` row, armed by PR-06 — the first PR with files in those
       * directories that a Postgres-free suite can reach (`src/{services,db,routes}` is PR-04's row in
       * `vitest.integration.config.ts`). A threshold over a scope with nothing in it is a guaranteed red, and
       * thresholds only ever ratchet upward, so the first PR that can pass a row is the PR that sets it.
       *
       * Written as glob keys because that is how §14 states the row: encryption and the error taxonomy are each
       * measured over themselves, rather than one aggregate number that a well-tested directory could carry for
       * an untested one. The values are §14's 80/80/75/80 **ratcheted to 85 across the board by PR-19**
       * (docs/plans/mvp/MVP-19.md §6, the post-PR-19 column), and the glob keys are read, not ignored: raising
       * one to an unreachable value fails the job with `does not meet "src/crypto/**" threshold (99.5%)`, which
       * is the only way to tell a threshold apart from a decorative object literal. Raising them is this PR's job
       * and no other's — a threshold is only worth having if the number went up somewhere — and the scope that
       * cannot meet the new floor gets tests in the PR that raises it rather than a lower number: for
       * `src/crypto/**` that was `keys.test.ts`, whose uncovered branches were the keyring configurations a
       * booted server is allowed to arrive with (a previous map holding a version nothing references, a current
       * version missing from it, a file-sourced key whose bytes are the wrong length).
       *
       * `src/db/rows.ts` joins them as a single file, and it is the exception that proves the split rule rather
       * than a loophole in it: it lives in `src/db/**`, which §14 gives to the integration job, but every branch
       * of `rawTimestamp`/`rawTextArray` is a *driver shape* — epoch-millis as text, Postgres's array literal —
       * that the real driver in that job never produces. Measured there it scored 12.85% of its branches and
       * took the scope's aggregate to 67.97% against a 75% floor (PR-09's first green-tests run), which is a
       * statement about the shapes a suite can summon, not about whether the file is tested. Here its own suite
       * can summon all of them, so it is measured at the same numbers as the two scopes above — 85, since
       * PR-19 moved all three at once.
       */
      thresholds: {
        'src/crypto/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
        'src/domain/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
        'src/db/rows.ts': { lines: 85, functions: 85, branches: 85, statements: 85 },
      },
    },
  },
});
