import { readFileSync } from 'node:fs';

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { Env } from './env.js';
import { createLogger } from './logger.js';
import { registerErrorHandlers } from './plugins/error-handler.js';
import { healthRoutes } from './routes/health.routes.js';

export interface BuildAppOptions {
  readonly env: Env;
  /**
   * Root logger override. Tests pass a silent instance; production passes nothing and gets the
   * pino logger described by `LOG_LEVEL`.
   */
  readonly logger?: FastifyBaseLogger;
  /** Reported by `/api/health`. Defaults to the version in `apps/server/package.json`. */
  readonly version?: string;
}

const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * Reads the app version from this package's manifest.
 *
 * The relative path is one level up from the *file*, which is `apps/server/package.json` from
 * both sides of the build: `src/app.ts` under `tsx` and `dist/app.js` after `tsc`.
 */
function serverVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * Builds the Fastify instance: logger, the §9.1 error envelope, health routes. **Dependency
 * injection is the point** — `app.inject()` in `app.test.ts` (and every `*.int.test.ts` from PR-04)
 * exercises the API without binding a port.
 *
 * PR-05 replaced PR-01's two placeholder handlers with `registerErrorHandlers()`, so an unknown
 * route, an over-cap body and an unhandled failure all answer the same envelope the client reads.
 *
 * Deliberately absent here:
 * * `@fastify/cookie`, the auth guard and CSRF (PR-07) — no auth in this PR;
 * * `fastify-type-provider-zod`, which the first route that validates a body registers (PR-07);
 * * `@fastify/static` + SPA fallback (PR-12), which will own the not-found answer for non-`/api`
 *   paths and must be registered before that changes anything here.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = options;

  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(env.LOG_LEVEL, env.NODE_ENV),
    trustProxy: env.TRUST_PROXY,
    // `MAX_NOTE_BYTES` is the transport-level body cap; the note-size rules of PR-09/PR-10 sit on
    // top of it, they do not replace it.
    bodyLimit: env.MAX_NOTE_BYTES,
  });

  // App-level, so one registration covers every route the later PRs add, `/api`-prefixed or not.
  registerErrorHandlers(app);

  await app.register(healthRoutes, { version: options.version ?? serverVersion() });

  return app;
}
