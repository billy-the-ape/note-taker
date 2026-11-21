/**
 * The CSRF decision as a table of request shapes (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * `decideCsrf` is a pure function over {@link CsrfRequestFacts} precisely so that this file can be exhaustive:
 * the Fastify hook around it is three lines and is covered end-to-end by
 * `routes/auth.routes.int.test.ts`, including the one-shot re-issue-and-replay the client of PR-05 performs.
 * What is worth pinning here is *which* branch refused, because the response never says (`403 FORBIDDEN` for
 * every reason) while the log line does.
 *
 * {@link ownOriginOf} — the origin the comparison uses — belongs in this file for the same reason: it is where a
 * deployment fails in silence, because a proxy that rewrites `Host` makes every mutation look cross-site. That
 * is a fact about the rule, not about the three-line hook around it, and PR-07's review found the dev proxy
 * doing exactly that.
 */
import { describe, expect, it } from 'vitest';

import { type CsrfRequestFacts, decideCsrf, ownOriginOf } from './csrf.js';

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

describe('the origin the comparison is made against (ownOriginOf)', () => {
  it('refuses the proxy-shaped Host/Origin pair the review found, rather than guessing about it', () => {
    // Exactly what `changeOrigin: true` produced in `pnpm dev`: the browser's truthful `Origin`, and a `Host`
    // the proxy had rewritten to the API target. With no `TRUST_PROXY` there is nothing else to go on — a proxy
    // this process has never heard of is not something the check can distinguish from a hostile rewrite — so the
    // answer is a refusal, and the fix belongs on the proxy (`vite.config.ts` pins `changeOrigin: false`).
    const proxied = { protocol: 'http', host: '127.0.0.1:3000' };
    expect(ownOriginOf(proxied)).toBe('http://127.0.0.1:3000');
    expect(
      decideCsrf(
        facts({
          path: '/api/auth/login',
          ownOrigin: ownOriginOf(proxied),
          origin: 'http://localhost:5173',
          cookieToken: undefined,
          headerToken: undefined,
        }),
      ),
    ).toEqual({ ok: false, reason: 'cross-site' });
  });

  it('follows the forwarded pair once the operator says a proxy is in front of us', () => {
    // The same request, now with `TRUST_PROXY=true`: `Host` says the machine, `X-Forwarded-Host` says the
    // authority the browser used, and that is the origin the `Origin` header has to match.
    const forwarded = {
      protocol: 'http',
      host: '127.0.0.1:3000',
      forwardedHost: 'localhost:5173',
      forwardedProto: 'http',
      trustProxy: true,
    };
    expect(ownOriginOf(forwarded)).toBe('http://localhost:5173');
    expect(decideCsrf(facts({ ownOrigin: ownOriginOf(forwarded), origin: 'http://localhost:5173' }))).toEqual(
      { ok: true },
    );

    // The TLS case `TRUST_PROXY` exists for: terminated upstream, so the app speaks http to its own proxy while
    // the browser is on https.
    const tls = { ...forwarded, forwardedHost: 'notes.example', forwardedProto: 'https' };
    expect(ownOriginOf(tls)).toBe('https://notes.example');
    // Trust in the forwarded host is not a blanket pass: another page's `Origin` is still a different origin,
    // which is the whole reason this half of the check exists.
    expect(decideCsrf(facts({ ownOrigin: ownOriginOf(tls), origin: 'https://evil.example' }))).toEqual({
      ok: false,
      reason: 'cross-site',
    });
  });

  it('ignores a forwarded pair it was not told to trust, and takes the last value when it was', () => {
    // Without the flag these are ordinary client headers: believing them would let any caller name its own
    // origin and walk straight through step 2.
    expect(ownOriginOf({ protocol: 'http', host: 'api.internal:3000', forwardedHost: 'evil.example' })).toBe(
      'http://api.internal:3000',
    );

    // A proxy that appends writes what it saw *after* whatever the client sent, so the leftmost entry is the
    // least trustworthy one and the one nearest to us is the last.
    expect(
      ownOriginOf({
        protocol: 'http',
        host: 'api.internal:3000',
        forwardedHost: 'evil.example, notes.example',
        trustProxy: true,
      }),
    ).toBe('http://notes.example');

    // A scheme that is not http(s) is not believed either — the request's own protocol is — and whitespace from
    // a hand-typed header does not survive the comparison.
    expect(
      ownOriginOf({ protocol: 'http', host: 'notes.example', forwardedProto: 'gopher', trustProxy: true }),
    ).toBe('http://notes.example');
    expect(
      ownOriginOf({
        protocol: 'https',
        host: 'api.internal:3000',
        forwardedHost: ' Notes.Example ',
        trustProxy: true,
      }),
    ).toBe('https://notes.example');
  });

  it('is the same shape as a browser Origin, which is what makes an exact comparison enough', () => {
    expect(ownOriginOf({ protocol: 'http', host: 'LocalHost:3000' })).toBe('http://localhost:3000');
    // An HTTP/1.0 client with no `Host` still gets a comparable origin rather than `http://undefined`, and the
    // tests above pin that a mismatch on it is a `403` either way.
    expect(ownOriginOf({ protocol: 'http' })).toBe('http://localhost');
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
