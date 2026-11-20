/**
 * The CSRF decision as a table of request shapes (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * `decideCsrf` is a pure function over {@link CsrfRequestFacts} precisely so that this file can be exhaustive:
 * the Fastify hook around it is three lines and is covered end-to-end by
 * `routes/auth.routes.int.test.ts`, including the one-shot re-issue-and-replay the client of PR-05 performs.
 * What is worth pinning here is *which* branch refused, because the response never says (`403 FORBIDDEN` for
 * every reason) while the log line does.
 */
import { describe, expect, it } from 'vitest';

import { type CsrfRequestFacts, decideCsrf } from './csrf.js';

const OWN = 'http://localhost:3000';

/** Facts for a same-origin mutation with a matching cookie/header pair, overridden per test. */
function facts(overrides: Partial<CsrfRequestFacts> = {}): CsrfRequestFacts {
  return {
    method: 'POST',
    path: '/api/folders',
    ownOrigin: OWN,
    cookieToken: 'cookie-value',
    headerToken: 'cookie-value',
    ...overrides,
  };
}

describe('the methods the check applies to', () => {
  it('does not apply to safe methods, which cannot change anything and often have no cookie', () => {
    expect(decideCsrf(facts({ method: 'GET', cookieToken: undefined, headerToken: undefined }))).toEqual({
      ok: true,
    });
    expect(decideCsrf(facts({ method: 'HEAD', cookieToken: undefined, headerToken: undefined }))).toEqual({
      ok: true,
    });
    expect(decideCsrf(facts({ method: 'OPTIONS', cookieToken: undefined, headerToken: undefined }))).toEqual({
      ok: true,
    });
  });

  it('applies to every unsafe method, whatever the case it arrived in', () => {
    for (const method of ['POST', 'post', 'PUT', 'PATCH', 'DELETE']) {
      expect(decideCsrf(facts({ method, headerToken: undefined }))).toMatchObject({
        ok: false,
        reason: 'missing-token',
      });
    }
  });
});

describe('the Origin / Sec-Fetch-Site half', () => {
  it('refuses a cross-site request even on a path that is exempt from the token check', () => {
    // The order matters: `POST /api/auth/login` from a hostile page carries no token and *is* exempt, so if the
    // Origin test came second this request would pass. A cross-site request that happens to present a matching
    // pair is still a cross-site request.
    expect(decideCsrf(facts({ path: '/api/auth/login', origin: 'http://evil.example' }))).toEqual({
      ok: false,
      reason: 'cross-site',
    });
  });

  it('trusts Sec-Fetch-Site when the client sends it, including the CORS-preflight value `none`', () => {
    expect(decideCsrf(facts({ secFetchSite: 'same-origin', origin: undefined }))).toEqual({ ok: true });
    expect(decideCsrf(facts({ secFetchSite: 'none', origin: undefined }))).toEqual({ ok: true });
    // `same-site` is the one a reader might expect to be fine: same *site* can still be a different origin, and
    // the cookie is bound to the origin, so it does not prove the request was made *by* us.
    expect(decideCsrf(facts({ secFetchSite: 'same-site' }))).toEqual({ ok: false, reason: 'cross-site' });
    expect(decideCsrf(facts({ secFetchSite: 'cross-site' }))).toEqual({ ok: false, reason: 'cross-site' });
    // A value this file has not been taught is a refusal, not a pass: the cost of guessing wrong is a `403`
    // somebody can retry, and the alternative is trusting a header whose vocabulary is not closed.
    expect(decideCsrf(facts({ secFetchSite: 'from-the-future' }))).toEqual({
      ok: false,
      reason: 'cross-site',
    });
  });

  it('treats the opaque `null` origin as cross-site rather than as an absent header', () => {
    // Absent means "a non-browser client with no concept of origin"; `null` means "a browser that told us it is
    // in an opaque context". Only the first is the curl case.
    expect(decideCsrf(facts({ origin: 'null' }))).toEqual({ ok: false, reason: 'cross-site' });
    expect(decideCsrf(facts({ origin: 'file:///etc/passwd' }))).toEqual({ ok: false, reason: 'cross-site' });
  });

  it('compares origins, not strings that look like them: a scheme or a port difference is a different origin', () => {
    expect(decideCsrf(facts({ origin: 'http://localhost:3001' }))).toEqual({
      ok: false,
      reason: 'cross-site',
    });
    expect(decideCsrf(facts({ origin: 'https://localhost:3000' }))).toEqual({
      ok: false,
      reason: 'cross-site',
    });
    // …and the scheme/host/port that do match, in any case, are the same origin.
    expect(decideCsrf(facts({ origin: OWN }))).toEqual({ ok: true });
    expect(decideCsrf(facts({ origin: 'http://LocalHost:3000' }))).toEqual({ ok: true });
    // A stray path is normalised away rather than refused. `Origin` is defined as a scheme/host/port triple, so
    // no browser sends `${OWN}/api/folders`; the leniency costs nothing, because the comparison is made on
    // `URL#origin` after parsing, and the alternative (refusing) would punish a hand-written `curl` header that
    // nobody meant to be hostile.
    expect(decideCsrf(facts({ origin: `${OWN}/api/folders` }))).toEqual({ ok: true });
  });

  it('lets a client with neither header through on the token half alone, because curl has no Origin', () => {
    expect(decideCsrf(facts({ origin: undefined, secFetchSite: undefined }))).toEqual({ ok: true });
    // A same-origin `POST` from a command line is a supported way to run this server's API; it is the reason
    // the token check is the second half rather than the only one.
  });
});

describe('the double-submit half', () => {
  it('skips it for the three login-family routes, which have no session and no cookie yet', () => {
    const withoutTokens = { cookieToken: undefined, headerToken: undefined };
    for (const path of ['/api/auth/login', '/api/auth/setup', '/api/auth/register']) {
      expect(decideCsrf(facts({ path, ...withoutTokens }))).toEqual({ ok: true });
    }
    // `GET /api/auth/status` *is* the route that issues the cookie, and it is a read: it is exempt by method.
    expect(decideCsrf(facts({ method: 'GET', path: '/api/auth/status', ...withoutTokens }))).toEqual({
      ok: true,
    });
  });

  it('refuses a mutation with no header, no cookie, or an empty cookie', () => {
    expect(decideCsrf(facts({ headerToken: undefined }))).toMatchObject({ reason: 'missing-token' });
    expect(decideCsrf(facts({ cookieToken: undefined }))).toMatchObject({ reason: 'missing-token' });
    // An empty value is a cookie a proxy or a broken client left behind, not a token that happens to be short.
    expect(decideCsrf(facts({ cookieToken: '', headerToken: '' }))).toMatchObject({
      reason: 'missing-token',
    });
  });

  it('refuses a header that does not match the cookie, and accepts one that does', () => {
    expect(decideCsrf(facts({ headerToken: 'other-value' }))).toMatchObject({ reason: 'token-mismatch' });
    // Different lengths are the easy case for a naive `===`, and the one `constantTimeEqual` must not throw on.
    expect(decideCsrf(facts({ headerToken: 'x' }))).toMatchObject({ reason: 'token-mismatch' });
    expect(decideCsrf(facts({ cookieToken: 'a-token', headerToken: 'a-token' }))).toEqual({ ok: true });
  });

  it('does not read the query string as part of the exempt path', () => {
    // Two layers make this untalkable-around: `isCsrfExempt` in the contract compares route paths and ignores a
    // query string of its own, and `pathOnly` in the hook means it is not even handed one.
    expect(decideCsrf(facts({ path: '/api/auth/login', cookieToken: undefined }))).toEqual({ ok: true });
    expect(decideCsrf(facts({ path: '/api/folders', cookieToken: undefined }))).toMatchObject({
      reason: 'missing-token',
    });
  });
});
