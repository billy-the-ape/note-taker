/**
 * The auth routes: the eight endpoints of plan §9.2 #2–#9 (docs/plans/mvp/MVP-07.md §4); the other two of the
 * ten this PR ships are `users.routes.ts`.
 *
 * A route here does four things and no more: parse the body with the shared contract schema, ask
 * `services/auth.service.ts` to do the work, translate a success into cookies and a status code, and let every
 * failure bubble up to the one error handler PR-05 installed. Nothing in this file decides policy — that is
 * what makes `POST /api/auth/login` and `POST /api/auth/password` answer `401` for the same reason in the same
 * words.
 *
 * Three transport facts that belong here rather than in the service:
 *
 * * **Cookies are written on the way out.** The session cookie carries the raw token and is set by the
 *   responses that minted a session; the CSRF cookie is re-issued by `GET /api/auth/status` and by every
 *   `setup`/`register`/`login`/`logout` response (§9.3) — exactly the set of responses a client could
 *   reasonably arrive at without one.
 * * **`204` has no body**, so those handlers end the reply themselves: `reply.code(204).send()` rather than
 *   `return`, because an async handler that returns `undefined` is Fastify's "nobody answered" path, not an
 *   empty response.
 * * **`GET /api/auth/session` is the only optional-auth route in the API.** It answers `{user: null}` for a
 *   stranger because the SPA calls it on every boot to decide which page to render, and a `401` from the
 *   endpoint whose whole job is "am I signed in" would send `lib/api.ts`'s unauthorized handler into a loop.
 */
import { loginSchema, ROUTES, type SessionResponse, type SessionUser } from '@note-taker/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { type CookiePolicy, clearSessionCookie, issueCsrfCookie, setSessionCookie } from '../http/cookies.js';
import { type AuthGuard, requestMeta } from '../plugins/auth-guard.js';
import { type AuthService, type SignedIn, toSessionUser } from '../services/auth.service.js';
import { changePasswordBodySchemaFor, setupSchema } from './auth.schemas.js';

export interface AuthRoutesOptions {
  readonly service: AuthService;
  readonly guard: AuthGuard;
  /** The `SECURE_COOKIES`/`SESSION_TTL_DAYS` pair, so this file never reads env (PR-01's rule). */
  readonly cookies: CookiePolicy;
}

/**
 * Writes the cookies a signed-in response carries and returns the `{user}` body (§9.2 #3–#5).
 *
 * One function, because the two cookies must never be written by only one of these routes: a `201` from
 * `POST /api/auth/register` that set the session but not the CSRF value would leave the freshly signed-up user
 * unable to make a single mutation, and the client's one-shot CSRF recovery cannot fix a cookie the server
 * never issued.
 */
function signedInResponse(
  reply: FastifyReply,
  result: SignedIn,
  cookies: CookiePolicy,
): { user: SessionUser } {
  setSessionCookie(reply, result.session.token, cookies);
  issueCsrfCookie(reply, cookies);
  return { user: result.user };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { service, guard, cookies }) => {
  /**
   * §9.2 #2 — `{needsSetup, registrationOpen}`, plus the cookie every client recovery depends on.
   *
   * The client may await this body twice (PR-05's one-shot CSRF replay); issuing the cookie on every call is
   * what makes that replay succeed, and the client's rule of "refetch at most once per `403`" is what stops
   * this being a cookie-minting oracle.
   */
  app.get(ROUTES.auth.status, async (_request, reply) => {
    issueCsrfCookie(reply, cookies);
    return service.status();
  });

  /**
   * §9.2 #3 — the first-run bootstrap: 200; CSRF-exempt like `register` and `login`, because the caller has no
   * cookie yet. `CSRF_EXEMPT_ROUTES` in `packages/contracts/src/routes.ts` is the list — the server and the SPA
   * both read it from the contract, and `plugins/csrf.ts` only asks `isCsrfExempt` whether a path is on it. 200
   * rather than 201 because the resource being created is the install, and `POST /setup` against a server that
   * is already set up is a `409`, not a second creation.
   */
  app.post(ROUTES.auth.setup, async (request, reply) => {
    const input = setupSchema.parse(request.body);
    return signedInResponse(reply, await service.setup(input, requestMeta(request)), cookies);
  });

  /**
   * §9.2 #4 — self-sign-up: 201. `403` when `ALLOW_REGISTRATION` is off or no owner exists yet, `409` when the
   * username is taken — which also writes an `auth_attempts` row — and `429` when this address has tried too
   * often. That window is keyed by the address, not by the username: what it throttles is a sweep of usernames,
   * and a username-keyed window is evaded by typing a new one every request (`http/rate-limit.ts`).
   */
  app.post(ROUTES.auth.register, async (request, reply) => {
    const input = setupSchema.parse(request.body);
    const result = await service.register(input, requestMeta(request));
    reply.code(201);
    return signedInResponse(reply, result, cookies);
  });

  /** §9.2 #5 — 200 `{user}`; `401` for every wrong answer; `429` with `Retry-After` after the tenth. */
  app.post(ROUTES.auth.login, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    return signedInResponse(reply, await service.login(input, requestMeta(request)), cookies);
  });

  /**
   * §9.2 #6 — deletes this session's row and expires the cookie. Not CSRF-exempt: it changes state and is not
   * one of the three login-family routes.
   *
   * The CSRF cookie is re-issued anyway. The next thing this browser does is sign in again, and the client
   * should not have to guess whether a signed-out jar still holds a usable token.
   */
  app.post(ROUTES.auth.logout, { preHandler: guard.requireAuth }, async (request, reply) => {
    const { tokenHash } = guard.authenticated(request);
    await service.logout(tokenHash);
    clearSessionCookie(reply, cookies);
    issueCsrfCookie(reply, cookies);
    return reply.code(204).send();
  });

  /**
   * §9.2 #7 — "sign out everywhere": every session row of this user, including the one making the request.
   *
   * How many rows went is deliberately not in the body: a `204` is the answer, and "which other devices just
   * stopped working" is a fact about the database that a caller can establish by trying to use one.
   */
  app.post(ROUTES.auth.logoutAll, { preHandler: guard.requireAuth }, async (request, reply) => {
    const { user } = guard.authenticated(request);
    await service.logoutAll(user.id);
    clearSessionCookie(reply, cookies);
    issueCsrfCookie(reply, cookies);
    return reply.code(204).send();
  });

  /**
   * §9.2 #8 — `{user|null, expiresAt?}`, resolved from the **row**. `expiresAt` accompanies a live session and
   * is absent when `user` is `null`; that is `sessionResponseSchema`'s rule, and the reason the two branches
   * are written out instead of one object with a conditional key.
   */
  app.get(ROUTES.auth.session, async (request): Promise<SessionResponse> => {
    const context = await guard.resolve(request);
    if (context === undefined) return { user: null };
    return { user: toSessionUser(context.user), expiresAt: context.expiresAt.toISOString() };
  });

  /**
   * §9.2 #9 — rotates the password, deletes every other session, and rotates *this* one so the caller stays
   * signed in on the device they used. `204` plus a `Set-Cookie` for the new token: no body, and nothing for a
   * proxy to cache about someone's credential change.
   *
   * `400 VALIDATION` for a new secret the policy forbids, including one equal to the username (plan §10) —
   * enforced by the body schema below, which is why the refusal happens before the argon2 verify rather than
   * after it. The username it is checked against comes from the session, never from the body.
   */
  app.post(ROUTES.auth.password, { preHandler: guard.requireAuth }, async (request, reply) => {
    const context = guard.authenticated(request);
    const input = changePasswordBodySchemaFor(context.user.username).parse(request.body);
    const session = await service.changePassword({
      user: context.user,
      actingTokenHash: context.tokenHash,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    setSessionCookie(reply, session.token, cookies);
    return reply.code(204).send();
  });
};
