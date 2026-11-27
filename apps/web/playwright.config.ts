/**
 * Playwright's configuration for the MVP acceptance proof (docs/plans/mvp/MVP-19.md §4).
 *
 * **It drives the compiled app, on one port, against a throwaway Postgres.** `webServer.command` is
 * `node apps/server/dist/index.js` — not `tsx`, not Vite dev (PR-19 §7): `pnpm build` has by then put `tsc`'s
 * output in `apps/server/dist` and Vite's in `apps/web/dist`, and PR-12's `plugins/static-spa.ts` serves the
 * latter from the former, which is the same single origin a deployed container offers. Everything the specs
 * assert is therefore an assertion about the artifact PR-18 ships: the hashed bundles, the CSP `@fastify/helmet`
 * puts on `index.html`, the `/app` shell fallback, and the migration that `index.ts` applies before `listen()`.
 *
 * **`NODE_ENV` is in `env`, not inherited.** `env.ts` fails in every mode without it, so a `webServer` that
 * inherited an unset `NODE_ENV` would die on the boot guard before the first spec ran, and the failure would
 * surface as "browser cannot load the URL" (§4). Same reason `DATABASE_URL` and the throwaway key are here
 * explicitly: they are the three things the app cannot boot without, and the suite must not depend on a
 * developer's `.env` to guess them.
 *
 * **One worker, on purpose.** The suite has one database and every file starts by emptying it
 * (`e2e/reset.ts`), exactly like the integration suite, which runs with `fileParallelism: false` for the same
 * reason. Two browsers sharing one truncated database produce failures that describe the harness rather than
 * the product; ~10 tests are not worth the wall-clock. Concurrency *inside* a test is a different thing and
 * still available — `autosave.spec.ts` opens two pages of one note deliberately.
 *
 * **`retries: 1`, and no more than that.** A transient e2e failure is worth one retry because a busy runner can
 * miss a frame; a suite that needs two is flaky, and the brief (§7) asks for three consecutive clean runs, which
 * is how that is proven. Reproducing a failure locally: `pnpm exec playwright test --retries=0 --debug`.
 */
import { defineConfig, devices } from '@playwright/test';

import { BASE_URL, IS_CI, READY_URL, REPO_ROOT, serverEnv } from './e2e/env';

export default defineConfig({
  testDir: './e2e',
  // Only `*.spec.ts` is a test. The harness modules beside them (`env`, `db`, `api`, `reset`, `fixtures`) are
  // ordinary TypeScript, and picking them up as "test files with zero tests" would make the suite lie about
  // what ran.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: IS_CI,
  // `list` for a human, `github` so the annotations land on the PR's checks, `html` for the trace of a failure.
  reporter: IS_CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The compiled entry point, from the repository root, so `defaultWebDistRoot()` resolves `apps/web/dist`
    // the same way it does inside PR-18's image.
    command: 'node apps/server/dist/index.js',
    cwd: REPO_ROOT,
    env: serverEnv(),
    url: READY_URL,
    reuseExistingServer: !IS_CI,
    // `pnpm build` has already run (the root `test:e2e` script does it), so this is generous rather than tight:
    // a container's first boot also runs the migration history.
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
