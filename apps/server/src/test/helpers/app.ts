/**
 * The app helper for DB-backed tests: build a real app, exercise it, close it.
 *
 * PR-01's `createTestLogger` is mandatory here. Fastify's default logger writes every request to stdout, and
 * PR-01's acceptance criterion is that a test run stays quiet enough to read.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import type { Keyring } from '../../crypto/keys.js';
import type { Db } from '../../db/client.js';
import { parseEnv } from '../../env.js';
import { createTestLogger } from '../../logger.js';

export interface WithAppOptions {
  /** The `/api/health` database probe; pass `probeDb(testDb())` to exercise the wired version. */
  readonly checkDb?: () => Promise<unknown>;
  /**
   * The pool to build the authenticated half on (PR-07). Omitted, `buildApp()` installs health only — which is
   * what PR-04's tests and PR-18's probe of a not-yet-started database assert.
   */
  readonly db?: Db;
  /**
   * Overrides for the test environment, e.g. `{ ALLOW_REGISTRATION: 'true' }` for the registration matrix in
   * `routes/registration.int.test.ts`. They are merged over `NODE_ENV=test`, never over the developer's shell:
   * an integration test's configuration is named in the test.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The keyring the note routes seal and open content with (PR-09/PR-10). Omitted, `buildApp()` takes
   * {@link getKeyring} — the one process-wide ring, which is what nearly every suite wants.
   *
   * It is here for the two suites that need a row written under one key and read under another: a key rotation is
   * not one process, it is the app restarted with a bumped `NOTE_ENCRYPTION_KEY_VERSION`, so a test that races a
   * rotation has to be able to hold two rings at once. `getKeyring()` caches per process, so the alternative —
   * pointing the env at the new key half way through a file — would leak into every later test in it.
   */
  readonly keyring?: Keyring;
  /**
   * A logger that is not the silent default (PR-09), for the one class of assertion the envelope makes
   * untestable from the response alone: a 500 whose useful half — which row failed — exists **only** in the log.
   * `captureLogs()` in `./log-capture.ts` builds one that records JSON lines; everything else stays silent, and
   * passing this must never be how a test decides a request *worked*.
   */
  readonly logger?: FastifyBaseLogger;
}

/**
 * Builds an app, `ready()`s it, hands it to `run`, and always closes it.
 *
 * The env is `parseEnv({ NODE_ENV: 'test', ...overrides })` rather than `parseEnv(process.env)` on purpose: a
 * route test should not change behaviour because a developer's `.env` sets `LOG_LEVEL=debug` or a different
 * port, and it should not change behaviour because a *previous* test needed `ALLOW_REGISTRATION`. Nothing binds
 * a port — every request goes through `app.inject()`.
 */
export async function withApp<T>(
  run: (app: FastifyInstance) => Promise<T>,
  options: WithAppOptions = {},
): Promise<T> {
  const { env: overrides, ...appOptions } = options;
  const app = await buildApp({
    env: parseEnv({ NODE_ENV: 'test', ...overrides }),
    logger: createTestLogger(),
    ...appOptions,
  });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}
