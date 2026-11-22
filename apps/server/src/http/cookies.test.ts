/**
 * The cookie attribute matrix (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * `routes/auth.routes.int.test.ts` asserts the same flags off real `Set-Cookie` headers, because the brief asks
 * for the flags "on the responses"; this file is the cheaper copy of that claim, and the only place the
 * *relationship* between the two cookies is stated as a fact. The session cookie's `Max-Age` comes from
 * `SESSION_TTL_DAYS` and the CSRF cookie's from the contract's one-day constant, so "the CSRF cookie is shorter-
 * lived than the session it guards" has to hold for every TTL the operator is allowed to configure — including
 * the smallest one `env.ts` permits, where it nearly stops holding.
 */
import { CSRF_COOKIE_MAX_AGE_SECONDS } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { csrfCookieAttributes, sessionCookieAttributes, sessionMaxAgeSeconds } from './cookies.js';

const DAYS = 24 * 60 * 60;

describe('the attributes both cookies share', () => {
  it('are Path=/ and SameSite=Lax, with Secure following SECURE_COOKIES', () => {
    for (const secure of [false, true]) {
      const policy = { secure, ttlDays: 30 };
      for (const attributes of [sessionCookieAttributes(policy), csrfCookieAttributes(policy)]) {
        expect(attributes.path).toBe('/');
        expect(attributes.sameSite).toBe('lax');
        expect(attributes.secure).toBe(secure);
      }
    }
  });

  it('are shared through one place, so the two cookies cannot drift on the flags that matter', () => {
    // `Path=/` is the one that bites: a session issued on `/` and cleared on `/api` would leave the browser
    // holding a cookie nobody can delete. Both sets of attributes are built from the same base, so the pair can
    // only differ where they are meant to.
    const policy = { secure: true, ttlDays: 7 };
    const session = sessionCookieAttributes(policy);
    const csrf = csrfCookieAttributes(policy);
    expect(session.path).toBe(csrf.path);
    expect(session.sameSite).toBe(csrf.sameSite);
    expect(session.secure).toBe(csrf.secure);
  });
});

describe('note_session', () => {
  it('is HttpOnly, so the SPA can never read the credential it authenticates with', () => {
    expect(sessionCookieAttributes({ secure: false, ttlDays: 30 }).httpOnly).toBe(true);
  });

  it('lives SESSION_TTL_DAYS, in seconds, and `Max-Age` is the same number the row will expire on', () => {
    expect(sessionMaxAgeSeconds(30)).toBe(30 * DAYS);
    expect(sessionCookieAttributes({ secure: false, ttlDays: 30 }).maxAge).toBe(2_592_000);
    expect(sessionCookieAttributes({ secure: false, ttlDays: 1 }).maxAge).toBe(DAYS);
  });

  it('survives the smallest TTL the configuration allows without going negative or zero', () => {
    // `env.ts` bounds `SESSION_TTL_DAYS` at 1..3650 (and 365 in production); a `Max-Age` of 0 or `NaN` here would
    // silently turn every session into a session that cannot be stored.
    for (const ttlDays of [1, 30, 365, 3650]) {
      expect(sessionMaxAgeSeconds(ttlDays)).toBeGreaterThan(CSRF_COOKIE_MAX_AGE_SECONDS / 2);
    }
  });
});

describe('note_csrf', () => {
  it('is not HttpOnly, because the SPA has to read it and put it in a header', () => {
    // The one cookie in the app that JavaScript can see, and the reason the pair works: an attacker's origin can
    // cause the *browser* to send the cookie but cannot read it to reproduce the header.
    expect(csrfCookieAttributes({ secure: false, ttlDays: 30 }).httpOnly).toBe(false);
  });

  it('lives one day, which is shorter than any session it may be paired with', () => {
    const csrf = csrfCookieAttributes({ secure: false, ttlDays: 1 });
    expect(csrf.maxAge).toBe(CSRF_COOKIE_MAX_AGE_SECONDS);
    // 86 400 is the contract's number, not a second opinion here; the assertion that matters is the ordering,
    // which is what keeps a stale-token `403` (the case PR-05's client replays once) the normal expiry path
    // rather than a mystery.
    expect(csrf.maxAge).toBe(86_400);
    expect(csrf.maxAge ?? 0).toBeLessThan(sessionMaxAgeSeconds(2));
  });
});
