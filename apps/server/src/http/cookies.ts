/**
 * The two cookies this API owns, in one place (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * Their attributes are the security story of the whole authentication design, so they are written once,
 * here, and every route that sets a cookie calls a function in this file rather than naming an option:
 *
 * | cookie         | flags                                                     | lifetime            | who issues it |
 * | -------------- | --------------------------------------------------------- | ------------------- | ------------- |
 * | `note_session` | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `SECURE_COOKIES=true` | `SESSION_TTL_DAYS` (30) | `setup`/`register`/`login`, rotated on `POST /api/auth/password` |
 * | `note_csrf`    | **not** `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` like the session | **1 day**           | `GET /api/auth/status` and every `setup`/`register`/`login`/`logout` response |
 *
 * The asymmetry is the point: the session cookie is only ever read by the server, so the SPA must not
 * be able to see it (`HttpOnly`); the CSRF value is read *by the SPA* and handed back in
 * `X-CSRF-Token`, so it must not be `HttpOnly` and must never be trusted just because it is present.
 *
 * `SameSite=Lax` rather than `Strict` because the plan wants a top-level link into the app to keep you
 * signed in, and `Path=/` because there is exactly one origin. `Secure` follows `SECURE_COOKIES` and
 * `env.ts` already refuses to boot in production with `TRUST_PROXY` or open registration and `Secure`
 * off, which is why nothing here re-litigates that.
 */
import { CSRF_COOKIE_MAX_AGE_SECONDS, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@note-taker/contracts';

import type { FastifyReply } from 'fastify';

import { newToken } from '../auth/tokens.js';

/**
 * The attributes this API's two cookies can have, spelled out rather than borrowed from
 * `@fastify/cookie`'s own parameter type: it is a subset of that type, so it still type-checks at the call, and
 * a change of cookie plugin cannot silently add an attribute nobody reviewed.
 */
export interface CookieAttributes {
  readonly path: string;
  readonly secure: boolean;
  readonly sameSite: 'strict' | 'lax' | 'none';
  readonly httpOnly: boolean;
  /** Seconds; omitted only by the deletion in {@link clearSessionCookie}, which expires by date instead. */
  readonly maxAge?: number;
  /** Only ever an instant in the past, which is how a cookie is deleted rather than shrunk. */
  readonly expires?: Date;
}

/** What the environment says about cookies, so this module never reads `process.env` (§16). */
export interface CookiePolicy {
  /** `SECURE_COOKIES`: off in dev, required by the production boot guard behind TLS. */
  readonly secure: boolean;
  /** `SESSION_TTL_DAYS`, the lifetime of both the cookie and the `sessions.expires_at` it names. */
  readonly ttlDays: number;
}

/** A day of seconds: `Max-Age` is seconds, `SESSION_TTL_DAYS` is days, and the two meet here. */
export function sessionMaxAgeSeconds(ttlDays: number): number {
  return ttlDays * 86_400;
}

/**
 * The attributes both cookies share. `HttpOnly` is not in here, because that is precisely the flag the
 * two cookies disagree about, so it belongs to each set of attributes and not to a common base.
 */
function baseAttributes(policy: CookiePolicy): Omit<CookieAttributes, 'httpOnly'> {
  return { sameSite: 'lax', path: '/', secure: policy.secure };
}

/** The `note_session` attributes (plan §10, "implement exactly"). */
export function sessionCookieAttributes(policy: CookiePolicy): CookieAttributes {
  return {
    ...baseAttributes(policy),
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds(policy.ttlDays),
  };
}

/**
 * The `note_csrf` attributes: one day, and deliberately not `HttpOnly` — `apps/web/src/lib/api.ts`
 * reads this value out of `document.cookie` and echoes it in the header.
 */
export function csrfCookieAttributes(policy: CookiePolicy): CookieAttributes {
  return {
    ...baseAttributes(policy),
    httpOnly: false,
    maxAge: CSRF_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * Rotates the session cookie. The value is the **raw** token: the database has already been given
 * `sha256(token)` by the caller, and only this response ever carries the secret.
 */
export function setSessionCookie(reply: FastifyReply, token: string, policy: CookiePolicy): FastifyReply {
  return reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieAttributes(policy));
}

/**
 * Expires the session cookie on the way out of `logout`/`logout-all`.
 *
 * The attributes have to match the ones it was set with (`Path=/` above all) or the browser would
 * treat this as a different cookie and keep the old one — which is the bug behind "I logged out but my
 * colleague still sees my notes on this machine". `expires` in the past rather than `maxAge: 0`, so a
 * proxy or a test jar with no clock still sees the deletion as a deletion.
 */
export function clearSessionCookie(reply: FastifyReply, policy: CookiePolicy): FastifyReply {
  return reply.clearCookie(SESSION_COOKIE_NAME, {
    ...baseAttributes(policy),
    httpOnly: true,
    expires: new Date(0),
  });
}

/**
 * Mints, sets and returns a fresh `note_csrf` value.
 *
 * Returned as well as set, because a caller that just re-issued the cookie sometimes wants to say
 * nothing else about it; and set as well as returned, because the pair — cookie and header — is the
 * entire CSRF defence in a single-instance MVP (plan §10: the cookie is not bound to a `sessions` row).
 */
export function issueCsrfCookie(reply: FastifyReply, policy: CookiePolicy): string {
  const token = newToken();
  reply.setCookie(CSRF_COOKIE_NAME, token, csrfCookieAttributes(policy));
  return token;
}
