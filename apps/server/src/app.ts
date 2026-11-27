import { readFileSync } from 'node:fs';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { createArgon2Hasher } from './auth/passwords.js';
import { getKeyring, type Keyring } from './crypto/keys.js';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import type { CookiePolicy } from './http/cookies.js';
import { createRateLimiter } from './http/rate-limit.js';
import { createLogger } from './logger.js';
import { type AuthGuard, createAuthGuard, registerAuthGuard } from './plugins/auth-guard.js';
import { registerCsrfGuard } from './plugins/csrf.js';
import { registerErrorHandlers } from './plugins/error-handler.js';
import { registerStaticSpa } from './plugins/static-spa.js';
import { authRoutes } from './routes/auth.routes.js';
import { folderRoutes } from './routes/folders.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { noteRoutes } from './routes/notes.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { treeRoutes } from './routes/tree.routes.js';
import { usersRoutes } from './routes/users.routes.js';
import { createAuthService } from './services/auth.service.js';
import { createFolderService } from './services/folder.service.js';
import { createNoteService } from './services/note.service.js';
import { createSettingsService } from './services/settings.service.js';
import { createTreeService } from './services/tree.service.js';

export interface BuildAppOptions {
  readonly env: Env;
  /**
   * The pool the auth routes need. Absent means **no auth routes at all**: `/api/health` and the error
   * envelope still answer, which is what every unit test built before PR-07 — and PR-18's container probe
   * against a database that is not up yet — depends on.
   *
   * Injected rather than reached for: `buildApp()` must stay usable from `app.inject()` in a process with no
   * database, and `getDb()` would make the import of this module a database requirement.
   */
  readonly db?: Db;
  /**
   * Root logger override. Tests pass a silent instance; production passes nothing and gets the
   * pino logger described by `LOG_LEVEL`.
   */
  readonly logger?: FastifyBaseLogger;
  /** Reported by `/api/health`. Defaults to the version in `apps/server/package.json`. */
  readonly version?: string;
  /**
   * The keyring the note routes seal and open content with (PR-09). Defaults to {@link getKeyring} — the one
   * process-wide ring built from `NOTE_ENCRYPTION_KEY`/`_FILE`/`_PREVIOUS`/`_VERSION`, or, in development and
   * test with nothing configured, the persisted key under `.dev/`.
   *
   * Injectable because a route test that wants a note it *cannot* read (the tampered-ciphertext case of
   * `notes.routes.int.test.ts`) is far cheaper to write with two rings than with a database write and a
   * re-decrypt.
   */
  readonly keyring?: Keyring;
  /**
   * The `/api/health` database probe (`probeDb(getDb().db)` in `index.ts`). Absent means the probe reports
   * the static `'ok'` it shipped with in PR-01, which is what every unit test and any pool-less boot uses.
   */
  readonly checkDb?: () => Promise<unknown>;
  /**
   * The directory the built SPA is served from (PR-12). Absent means `apps/web/dist`, and **a directory
   * with no `index.html` in it serves nothing** — which is why the whole test suite, and `pnpm dev` with
   * no `pnpm build` run, are unaffected by this option existing. Read `plugins/static-spa.ts` before
   * changing it: the path is a repository/image layout fact, not an operator knob, which is why it is an
   * option here rather than a variable in `env.ts`.
   */
  readonly webDist?: string;
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
 * PR-07 added the auth half: `@fastify/cookie`, `@fastify/helmet`, the CSRF guard, the session guard, and the
 * ten routes of `routes/auth.routes.ts` + `routes/users.routes.ts`. They are registered only when a pool is
 * passed in `options.db`, so an instance without a database is still a valid, smaller instance — which is what
 * every unit test in `app.test.ts` and PR-18's probe of a not-yet-started database rely on.
 *
 * Deliberately absent here:
 * * `fastify-type-provider-zod` — the auth routes validate with `schema.parse(request.body)` and let the
 *   resulting `ZodError` reach `mapError()`, which already renders it as `400 VALIDATION` with `details`
 *   (PR-05). A type provider earns its keep once routes declare `schema` for their *responses*; none do yet.
 *
 * PR-12 added `plugins/static-spa.ts` at the end of this function: `@fastify/static` over `apps/web/dist`
 * with the `/app` fallback, registered after every API route so no `/api` path is ever swallowed. It is a
 * route like any other, so the helmet headers registered inside {@link registerAuth} — and the error envelope —
 * apply to the served shell too: `script-src 'self'` covers Vite's hashed bundles, and the CSP's one concession
 * (inline *styles*, whose reason is written out in {@link helmetOptions}) is what a same-origin stylesheet plus
 * an editor's measurement pass need. If a later build starts inlining a `<script>`, that is a CSP conversation
 * to have then, not a directive to widen now.
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

  await app.register(healthRoutes, {
    version: options.version ?? serverVersion(),
    // `exactOptionalPropertyTypes` means `{ checkDb: undefined }` is not the same as omitting the key, so the
    // option is spread only when there is a probe to pass (PR-01's static `'ok'` otherwise).
    ...(options.checkDb === undefined ? {} : { checkDb: options.checkDb }),
  });

  if (options.db !== undefined) {
    // `exactOptionalPropertyTypes` again: an absent `keyring` must reach the default parameter of
    // {@link registerAuth} as `undefined`, which is what `getKeyring()` below then resolves.
    await registerAuth(app, env, options.db, options.keyring);
  }

  // Last, so the API is routed first whatever the build directory contains: `static-spa` registers one
  // route per file rather than a catch-all, but the ordering is what makes "`/api/*` is never swallowed"
  // true by construction instead of by inspection (docs/plans/mvp/MVP-12.md §6).
  await registerStaticSpa(app, options.webDist === undefined ? {} : { root: options.webDist });

  return app;
}

/**
 * Puts the authenticated half of the API on an instance: cookie parsing, security headers, the two guards, and
 * the ten routes of `auth.routes.ts` (8) + `users.routes.ts` (2).
 *
 * The order of the first three statements is load-bearing and easy to break later. `@fastify/cookie` has to be
 * registered **before** {@link registerCsrfGuard} adds its `onRequest` hook, because Fastify runs root
 * `onRequest` hooks in registration order and the CSRF decision reads `request.cookies` — registered the other
 * way round, every mutation would be refused for a cookie the request never got the chance to parse, and every
 * test in the file would be a mystery.
 *
 * One {@link AuthService}, one rate-limit window and one hasher per instance, on purpose: the window *is* this
 * process's memory (see `http/rate-limit.ts`), so two instances would mean two lockouts, and a test that builds
 * its own app gets a clean window rather than inheriting one from whatever ran before it in the same process.
 */
async function registerAuth(
  app: FastifyInstance,
  env: Env,
  db: Db,
  keyring: Keyring = getKeyring(),
): Promise<void> {
  await app.register(cookie);
  await app.register(helmet, helmetOptions());

  const guard: AuthGuard = createAuthGuard({ db });
  const cookies: CookiePolicy = { secure: env.SECURE_COOKIES, ttlDays: env.SESSION_TTL_DAYS };
  const service = createAuthService({
    db,
    passwords: createArgon2Hasher(),
    rateLimiter: createRateLimiter({ max: env.LOGIN_RATE_LIMIT_MAX }),
    allowRegistration: env.ALLOW_REGISTRATION,
    sessionTtlDays: env.SESSION_TTL_DAYS,
  });

  registerAuthGuard(app);
  registerCsrfGuard(app, { trustProxy: env.TRUST_PROXY });

  await app.register(authRoutes, { service, guard, cookies });
  await app.register(usersRoutes, { service, guard });

  // PR-09's domain surface, registered from here rather than from `buildApp()` so it shares the two guards
  // above: a second `registerAuthGuard` would resolve the same session cookie twice per request for no benefit,
  // and the CSRF guard has to be in place before a browser may issue a folder `PATCH` at all.
  await registerDomain(app, db, guard, keyring);
}

/**
 * The domain half of the API (docs/plans/mvp/MVP-09.md, plus `PUT /api/notes/:id/content` from
 * docs/plans/mvp/MVP-10.md): `tree.routes.ts` (1) + `folders.routes.ts` (3) + `notes.routes.ts` (5) +
 * `settings.routes.ts` (2).
 *
 * One service object per process, each built over the same injected pool, which is what makes the folder
 * transaction and the note's envelope share a connection with the rest of the request. Two things are
 * deliberately *not* constructed here:
 *
 * * **The keyring is passed in**, defaulting to {@link getKeyring} at the call site. Only
 *   `services/note.service.ts` ever holds one, and `GET /api/tree` proves it: the tree is served without a key.
 * * **No per-request state of any kind.** `createFolderService` closes over the pool and nothing else, so the
 *   advisory lock in a folder mutation is held by the *transaction*, not by a service instance — which is the
 *   only way two concurrent requests from one user can be serialised by Postgres rather than by whoever happened
 *   to build the object.
 */
async function registerDomain(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  keyring: Keyring,
): Promise<void> {
  const folderService = createFolderService({ db });
  const noteService = createNoteService({ db, keyring });
  const treeService = createTreeService({ db });
  const settingsService = createSettingsService({ db });

  await app.register(treeRoutes, { service: treeService, guard });
  await app.register(folderRoutes, { service: folderService, guard });
  await app.register(noteRoutes, { service: noteService, guard });
  await app.register(settingsRoutes, { service: settingsService, guard });
}

/**
 * The security headers of plan §10, with the three places this app differs from helmet's defaults written out
 * rather than inherited (docs/plans/mvp/MVP-07.md §5: CSP with no `unsafe-eval`, `nosniff`,
 * `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` — the last two of those are helmet's own behaviour, and
 * `x-powered-by` is removed with them).
 *
 * * **No HSTS.** The header only means anything over HTTPS, and the operator who experiments with a certificate
 *   on a home server and then goes back to plain HTTP would be locked out of their own machine by every browser
 *   that saw the pin. TLS policy belongs to whatever terminates TLS — PR-18's compose file, or the reverse proxy
 *   the operator chooses — not to an app whose development mode is `http://localhost:3000`.
 * * **`Referrer-Policy: no-referrer`** instead of helmet's `no-referrer-when-downgrade`, because the note titles
 *   in a `?q=` query string are exactly what a referrer leaks, and there is no analytics here for it to be sent
 *   to.
 * * **A hand-written CSP**, because it is PR-12's document that will be governed by it: everything comes from
 *   this one origin; scripts are `'self'` with **no `unsafe-eval`** (a bundler's output has no reason to evaluate
 *   strings, and `unsafe-eval` would turn any fetched file into a script tag); styles add `'unsafe-inline'`
 *   because CodeMirror and the toast library of plan §12 insert `<style>` elements at runtime. That is the one
 *   exception, it is a *style* exception, and `style-src-elem` is where to narrow it if PR-12 ever needs to.
 */
function helmetOptions() {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // The built stylesheet is same-origin, and `'unsafe-inline'` is here for the `<style>` elements
        // CodeMirror's measurement pass and the toast library insert at runtime. Scripts get no such
        // concession: an XSS that can inject a `<style>` is a cosmetic problem, one that can inject a
        // `<script>` is somebody else's notes.
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
      },
    },
    hsts: false,
    // §5 of the brief names this header, and helmet's own default is `SAMEORIGIN` — which for a single-origin
    // app is close to no protection at all, since anything same-origin (a stored `<iframe>` in a note that ever
    // rendered HTML, a future error page) could frame the signed-in UI. `DENY` matches the CSP above, which
    // already says `frame-ancestors 'none'`; the two headers are read by different generations of browser.
    frameguard: { action: 'deny' as const },
    crossOriginResourcePolicy: { policy: 'same-origin' as const },
    referrerPolicy: { policy: 'no-referrer' as const },
  };
}
