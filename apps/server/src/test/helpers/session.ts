/**
 * Signing real sessions in over HTTP, for the route-level integration suites.
 *
 * PR-09 is the first PR with five route files that all need the same three steps — bootstrap the owner, create a
 * member, sign the member in — and each of them needs the *cookie jar*, not a synthesised session row: the
 * criteria these files test are about the wire (a 401 before the service runs, a CSRF-rejected mutation, another
 * user's id answered with a 404 that is byte-identical to a missing one). A session inserted straight into
 * `sessions` would prove those three things less well, and would not exercise the guard at all.
 *
 * The three steps are also the only honest order: `/setup` may only be called by nobody, `/api/users` only by the
 * owner, and a member's session can only come from a login with the password the owner just chose.
 *
 * `withApp`'s `env` override is the caller's business: this helper deliberately does not know about
 * `ALLOW_REGISTRATION`, because nothing here needs it.
 */
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, ROUTES } from '@note-taker/contracts';
import type { FastifyInstance } from 'fastify';

import { cookieHeader, cookieValue, type Jar, jarAfter, jarHeaders } from './cookies.js';

/** Long enough for plan §10's minimum and not a password anyone reuses; these are test-only accounts. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';
export const TEST_MEMBER_PASSWORD = 'a-different-secret-word';

/** `POST /api/auth/setup`: the first account in an empty install, signed in. */
export async function bootstrapOwner(
  app: FastifyInstance,
  {
    username = 'owner',
    password = TEST_PASSWORD,
  }: { readonly username?: string; readonly password?: string } = {},
): Promise<Jar> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTES.auth.setup,
    payload: { username, password },
  });
  if (response.statusCode !== 200) throw new Error(`setup failed (${response.statusCode}): ${response.body}`);
  return jarAfter(response);
}

/** `POST /api/auth/login` for an account that already exists. */
export async function signIn(
  app: FastifyInstance,
  username: string,
  password: string = TEST_PASSWORD,
): Promise<Jar> {
  const response = await app.inject({
    method: 'POST',
    url: ROUTES.auth.login,
    payload: { username, password },
  });
  if (response.statusCode !== 200) throw new Error(`login failed (${response.statusCode}): ${response.body}`);
  return jarAfter(response);
}

/**
 * The owner creates a member and the member signs in: the two-user setup every cross-user criterion needs.
 *
 * The member's session comes from a login rather than from the caller's jar, because a test that reused the
 * owner's jar would be asserting one user's rights while pretending to assert another's.
 */
export async function createMember(
  app: FastifyInstance,
  owner: Jar,
  {
    username = 'member',
    password = TEST_MEMBER_PASSWORD,
  }: { readonly username?: string; readonly password?: string } = {},
): Promise<Jar> {
  const created = await app.inject({
    method: 'POST',
    url: ROUTES.users,
    headers: jarHeaders(owner),
    payload: { username, password },
  });
  if (created.statusCode !== 201)
    throw new Error(`create user failed (${created.statusCode}): ${created.body}`);
  return signIn(app, username, password);
}

/**
 * The id behind a jar, asked of the app itself through `GET /api/auth/session`.
 *
 * A test that reached into `users` for an id would be trusting its own insert; this asks the same endpoint the
 * SPA asks, so a jar and an id can never quietly disagree about who is signed in.
 */
export async function whoAmI(app: FastifyInstance, jar: Jar): Promise<string> {
  const response = await app.inject({ method: 'GET', url: ROUTES.auth.session, headers: jarHeaders(jar) });
  const body = response.json() as { user?: { id?: string } };
  const id = body.user?.id;
  if (typeof id !== 'string') throw new Error(`no session for this jar: ${response.body}`);
  return id;
}

/** The error envelope of a response, without the per-request id, so two failures can be compared byte for byte. */
export function envelopeOf(response: { json(): unknown }): Record<string, unknown> {
  const { error } = response.json() as { error: Record<string, unknown> };
  const { requestId: _requestId, ...envelope } = error;
  return envelope;
}

/**
 * Headers of a **signed-out** browser that still holds a live `note_csrf` pair: the cookie and the matching
 * `X-CSRF-Token`, and no `note_session`.
 *
 * Why a route test needs this: the CSRF guard is an app-wide `onRequest` hook (`plugins/csrf.ts`), so it decides
 * a mutation *before* `requireAuth` sees it, and it answers `403` — never `401`, because a stale token says
 * nothing about whether the caller is signed in (the SPA's one-shot recovery keys off exactly that). A test that
 * sends an anonymous `POST` with no headers therefore measures the CSRF guard, not the session guard, and cannot
 * tell a 401 regression from a 403 one. These headers say "the token half is fine, now show me what you do about
 * the missing session", which is the assertion PR-09's routes actually need. The pair is not a credential —
 * `GET /api/auth/status` hands it to anybody who asks, which is the point of double-submit.
 *
 * A request that *lacks* the header is still worth asserting, and PR-09 does: that one is `403`.
 */
export async function signedOutCsrfHeaders(app: FastifyInstance): Promise<Record<string, string>> {
  const status = await app.inject({ method: 'GET', url: ROUTES.auth.status });
  if (status.statusCode !== 200)
    throw new Error(`${ROUTES.auth.status} failed (${status.statusCode}): ${status.body}`);
  const token = cookieValue(status, CSRF_COOKIE_NAME);
  if (token === undefined)
    throw new Error(
      `${ROUTES.auth.status} issued no ${CSRF_COOKIE_NAME} cookie: ${status.headers['set-cookie']}`,
    );

  const cookie = cookieHeader({ [CSRF_COOKIE_NAME]: token });
  return { cookie: cookie ?? '', [CSRF_HEADER_NAME.toLowerCase()]: token };
}
