/**
 * Session resolution and the two route guards (`requireAuth`, `requireOwner`)
 * (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * **The cookie is a claim, never a fact.** `note_session` says "look up `sha256(this)`"; everything the API
 * believes about who is calling comes from the row that lookup found, and the cookie's own expiry is
 * irrelevant: `GET /api/auth/session` answers `{user: null}` for a session row that has aged out even while
 * the cookie is still sitting in the jar, because the row is what the plan makes authoritative (§10 — the
 * brief's acceptance line is literally "not when the cookie expires"). The reverse is equally true: a live row
 * with no cookie is a signed-out client, and there is nothing to resolve.
 *
 * Resolution is **lazy on purpose**. It is not an `onRequest` hook: `GET /api/health` is polled from outside
 * the container by PR-18's `HEALTHCHECK`, and a health probe that needs a `sessions` join is a probe that
 * fails when the database is busy rather than when it is down. A route asks, and the answer is memoised on the
 * request, so a route and its guard never cost two lookups.
 *
 * `requireAuth` and `requireOwner` are preHandlers, so a `401`/`403` is answered before any route body runs and
 * every route below reads one already-decided `request.auth` — which is how PR-09's repositories get a `userId`
 * they can trust without re-checking it.
 */
import { SESSION_COOKIE_NAME } from '@note-taker/contracts';
// The concrete hook type rather than `RouteOptions['preHandler']`: that one is optional, and under
// `exactOptionalPropertyTypes` handing `{ preHandler: guard.requireAuth }` something whose type includes
// `undefined` is a type error on every route that uses a guard.
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { hashToken, sessionIsLive } from '../auth/tokens.js';
import type { Db } from '../db/client.js';
import {
  deleteSessionByTokenHash,
  sessionOwnerByTokenHash,
  touchSession,
} from '../db/repositories/sessions.repo.js';
import type { Session, User } from '../db/schema.js';
import { ForbiddenError, UnauthorizedError } from '../domain/errors.js';

/** What an authenticated request knows about its caller. */
export interface AuthContext {
  /** The `users` row, exactly as stored — including `password_hash`, which no route may serialise. */
  readonly user: User;
  /** `sha256(cookie)`: the handle for rotating or deleting *this* session and no other. */
  readonly tokenHash: Uint8Array;
  /** The row's `expires_at`, so a route can report it without a second read (`GET /api/auth/session`). */
  readonly expiresAt: Date;
  readonly session: Session;
}

export interface AuthGuard {
  /** Who is calling, or `undefined`. Never throws: `GET /api/auth/session` is an *optional*-auth route. */
  readonly resolve: (request: FastifyRequest) => Promise<AuthContext | undefined>;
  /** `401 UNAUTHORIZED` unless the caller has a live session, then memoises it on the request. */
  readonly requireAuth: preHandlerHookHandler;
  /** As {@link AuthGuard.requireAuth}, then `403 FORBIDDEN` unless the caller is the owner. */
  readonly requireOwner: preHandlerHookHandler;
  /**
   * The caller `requireAuth`/`requireOwner` established. Throws if the route was reached without one of them,
   * which is the only way `request.auth` can be missing here — a route that forgot the preHandler.
   */
  readonly authenticated: (request: FastifyRequest) => AuthContext;
}

export interface AuthGuardOptions {
  readonly db: Db;
  /** The clock that decides expiry — one "now" per resolution, so `expires_at` is never compared to two. */
  readonly now?: () => Date;
  /**
   * How stale `sessions.last_seen_at` may get before a request refreshes it. Five minutes, because an
   * authenticated SPA issues a dozen requests per interaction and PR-14's autosave loop will add more: the
   * column is a hint for a human reading the table, and it is not worth a write per request.
   */
  readonly lastSeenThresholdMs?: number;
}

/** See {@link AuthGuardOptions.lastSeenThresholdMs}. */
const DEFAULT_LAST_SEEN_THRESHOLD_MS = 5 * 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by {@link AuthGuard.resolve} on the request that asked, so a preHandler and its route share one
     * answer. Absent until then, which is a bug in the route rather than a state to branch on — see
     * {@link AuthGuard.authenticated}.
     */
    auth?: AuthContext;
  }
}

/**
 * Declares the decorator. Called once by `buildApp()`, app-wide: a request property Fastify has not been told
 * about is not a property a hook may set.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.decorateRequest('auth', undefined);
}

/** Builds the guard over one pool. */
export function createAuthGuard(options: AuthGuardOptions): AuthGuard {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const thresholdMs = options.lastSeenThresholdMs ?? DEFAULT_LAST_SEEN_THRESHOLD_MS;

  async function resolve(request: FastifyRequest): Promise<AuthContext | undefined> {
    const already = request.auth;
    if (already !== undefined) return already;

    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined || token === '') return undefined;
    const tokenHash = hashToken(token);

    const found = await sessionOwnerByTokenHash(db, tokenHash);
    if (found === undefined) return undefined;

    const at = now();
    if (!sessionIsLive(found.session.expiresAt, at)) {
      // The row is gone as far as anyone can tell, so it stops being a row: a cookie that outlived its session
      // by days would otherwise sit in the table until an operator noticed. Deleting by the primary key is one
      // indexed statement, on the rare request that proves the row was dead.
      await deleteSessionByTokenHash(db, tokenHash);
      return undefined;
    }

    if (at.getTime() - found.session.lastSeenAt.getTime() >= thresholdMs) {
      await touchSession(db, tokenHash, at);
    }

    const context: AuthContext = {
      user: found.user,
      tokenHash,
      expiresAt: found.session.expiresAt,
      session: found.session,
    };
    request.auth = context;
    return context;
  }

  /**
   * The guards return nothing: a preHandler that hands Fastify a value has *answered with a payload*, and the
   * session object would be the response body of every authenticated route in the API.
   */
  const requireAuth = async (request: FastifyRequest): Promise<void> => {
    const context = await resolve(request);
    if (context === undefined) {
      // One message for "no cookie", "unknown cookie" and "expired cookie". A `401` that distinguishes them is
      // a map of the session table, and the client's `onUnauthorized` hook does one thing with it either way.
      throw new UnauthorizedError();
    }
  };

  const requireOwner = async (request: FastifyRequest): Promise<void> => {
    await requireAuth(request);
    const context = request.auth;
    if (context === undefined || context.user.role !== 'owner') {
      // `403`, not `404`: this is a capability the caller lacks, and pretending the route is missing would
      // make `GET /api/users` answer differently for the two kinds of failure it can have.
      throw new ForbiddenError('this action needs the owner role');
    }
  };

  return {
    resolve,
    requireAuth,
    requireOwner,
    authenticated: (request) => {
      const context = request.auth;
      if (context === undefined) {
        throw new UnauthorizedError('this route needs a session');
      }
      return context;
    },
  };
}

/** The per-request facts a session row records about the device that made it. */
export function requestMeta(request: FastifyRequest): {
  readonly ip: string;
  readonly userAgent: string | null;
} {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}
