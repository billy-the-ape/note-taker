/**
 * The app helper for DB-backed tests: build a real app, exercise it, close it.
 *
 * PR-01's `createTestLogger` is mandatory here. Fastify's default logger writes every request to stdout, and
 * PR-01's acceptance criterion is that a test run stays quiet enough to read.
 */
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../app.js';
import { parseEnv } from '../../env.js';
import { createTestLogger } from '../../logger.js';

export interface WithAppOptions {
  /** The `/api/health` database probe; pass `probeDb(testDb())` to exercise the wired version. */
  readonly checkDb?: () => Promise<unknown>;
}

/**
 * Builds an app, `ready()`s it, hands it to `run`, and always closes it.
 *
 * The env is `parseEnv({ NODE_ENV: 'test' })` rather than `parseEnv(process.env)` on purpose: a route test
 * should not change behaviour because a developer's `.env` sets `LOG_LEVEL=debug` or a different port. Nothing
 * binds a port — every request goes through `app.inject()`.
 */
export async function withApp<T>(
  run: (app: FastifyInstance) => Promise<T>,
  options: WithAppOptions = {},
): Promise<T> {
  const app = await buildApp({
    env: parseEnv({ NODE_ENV: 'test' }),
    logger: createTestLogger(),
    ...options,
  });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}
