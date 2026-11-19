import { readFileSync } from 'node:fs';

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { Env } from './env.js';
import { createLogger } from './logger.js';
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
  /**
   * The `/api/health` database probe (`probeDb(getDb().db)` in `index.ts`). Absent means the probe reports
   * the static `'ok'` it shipped with in PR-01, which is what every unit test and any pool-less boot uses.
   */
  readonly checkDb?: () => Promise<unknown>;
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
 * Fastify's error handler receives `unknown` on purpose (a plugin or hook can throw anything), so
 * reading `statusCode` needs a narrow look rather than a cast to a shape that may not be there.
 */
function statusCodeOf(error: unknown): number {
  const candidate: unknown =
    error instanceof Error ? (error as { readonly statusCode?: unknown }).statusCode : undefined;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500;
}

/**
 * Builds the Fastify instance: logger, health routes, error placeholders. **Dependency injection
 * is the point** — `app.inject()` in `app.test.ts` (and every `*.int.test.ts` from PR-04) exercises
 * the API without binding a port.
 *
 * Deliberately absent here:
 * * `@fastify/cookie`, the auth guard and CSRF (PR-07) — no auth in this PR;
 * * the Zod type provider and the §9.1 error envelope (PR-05);
 * * `@fastify/static` + SPA fallback (PR-12).
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

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: `no route for ${request.method} ${request.url}` } });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const status = statusCodeOf(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      // Never leak the internal failure to the client; PR-05 turns this into a trace id.
      reply.status(status).send({ error: { code: 'internal_error', message: 'internal error' } });
      return;
    }
    const message = error instanceof Error ? error.message : 'bad request';
    reply.status(status).send({ error: { code: 'bad_request', message } });
  });

  await app.register(healthRoutes, {
    version: options.version ?? serverVersion(),
    // `exactOptionalPropertyTypes` means `{ checkDb: undefined }` is not the same as omitting the key, so the
    // option is spread only when there is a probe to pass (PR-01's static `'ok'` otherwise).
    ...(options.checkDb === undefined ? {} : { checkDb: options.checkDb }),
  });

  return app;
}
