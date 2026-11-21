/**
 * The CSRF guard: cookie-to-header double submit, plus the `Origin`/`Sec-Fetch-Site` check
 * (docs/plans/mvp/MVP-07.md §5, plan §9.3 and §10).
 *
 * The rule, in the order the code applies it:
 *
 * 1. **Only state-changing methods are checked** (`isMutationMethod` from the contract, so the SPA and this
 *    file cannot disagree about what a mutation is).
 * 2. **Every mutation, exempt routes included, has to look same-origin.** A request that carries
 *    `Sec-Fetch-Site: cross-site`, or an `Origin` that is not this server's own origin, is refused with the
 *    same `403`. A request with *neither* header is allowed, because that is what a non-browser client
 *    (curl, a monitoring script, the test harness) sends, and there is no third-party context to defend
 *    against: the attacker in this model is a *page in the victim's browser*, and a browser says which page
 *    it is on every single time. "This server's own origin" is `protocol` + `Host`, with one exception worth
 *    knowing before debugging a `403` at 3 a.m.: under `TRUST_PROXY` the `X-Forwarded-Host`/`X-Forwarded-Proto`
 *    pair wins, because a TLS-terminating proxy that rewrites `Host` is otherwise indistinguishable from a
 *    cross-site request ({@link ownOriginOf} is that rule, and it is why `apps/web/vite.config.ts` pins
 *    `changeOrigin: false`).
 * 3. **The three login-family routes are exempt from the header check** — `isCsrfExempt` reads the shared
 *    route list — because a first-time visitor has no `note_csrf` cookie to echo, and step 2 is what guards
 *    them. Every other mutation needs `X-CSRF-Token` to be present and to equal the `note_csrf` cookie.
 *
 * Why the pair, and not just the header: the value is not signed, not bound to a session row, and readable by
 * any script on the page (it has to be — the SPA reads it out of `document.cookie`), so on its own the equality
 * only proves "this client can read cookies for this origin", which a same-site page can also do.
 * `Origin`/`Sec-Fetch-Site` is what makes the *cross-site* case impossible. Plan §10 says the double-submit is
 * deliberately unbound to a `sessions` row in a single-instance MVP, and `sessions.csrf` is backlog.
 *
 * A `403` here is also the trigger for the client's one-shot recovery (`apps/web/src/lib/api.ts` refetches
 * `GET /api/auth/status`, which re-issues the cookie, and replays once), so this file must answer `403` and
 * never `401`: a stale CSRF token says nothing about whether the caller is signed in, and a client that bounced
 * to the sign-in screen on `403` would lose an unsaved note over an expired cookie.
 */
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, isCsrfExempt, isMutationMethod } from '@note-taker/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { constantTimeEqual } from '../auth/passwords.js';
import { ForbiddenError } from '../domain/errors.js';

/** Why a request was refused. Logged, never sent: the reason tells an attacker which half they defeated. */
export type CsrfRejectReason = 'cross-site' | 'missing-token' | 'token-mismatch';

export type CsrfVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: CsrfRejectReason };

export interface CsrfRequestFacts {
  /** The request method, any case — `isMutationMethod` is the only judge. */
  readonly method: string;
  /** The request path without its query string. */
  readonly path: string;
  /** This server's own origin, e.g. `http://localhost:3000` — {@link ownOriginOf} says where it comes from. */
  readonly ownOrigin: string;
  readonly cookieToken?: string | undefined;
  readonly headerToken?: string | undefined;
  readonly origin?: string | undefined;
  readonly secFetchSite?: string | undefined;
}

/** `Sec-Fetch-Site` values a request may have and still be treated as same-origin (§10). */
const SAME_SITE_VALUES: readonly string[] = ['same-origin', 'none'];

/**
 * The comparable form of an origin, or `undefined` for anything that is not one (`null`, an opaque origin, a
 * value with a path, a header someone typed by hand).
 *
 * Only http(s) counts: those are the schemes that can carry this API's cookies at all, and the `null` origin a
 * browser sends for an opaque-context request is cross-site by definition.
 */
function parseOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The same-origin question, answered from whatever the client said about itself. */
function isCrossSite(facts: CsrfRequestFacts): boolean {
  if (facts.secFetchSite !== undefined) {
    // An unknown value counts as cross-site: a client that invents a new one is a client this file has not
    // been taught to trust, and the cost of guessing wrong is a `403` for someone who can retry.
    if (!SAME_SITE_VALUES.includes(facts.secFetchSite.toLowerCase())) return true;
  }
  const origin = parseOrigin(facts.origin);
  // A present-but-unparseable `Origin` is a refusal, not an absence: "we could not read it" is not the same
  // answer as "the client never said", and only the second one is a non-browser client.
  if (facts.origin !== undefined && origin === undefined) return true;
  return origin !== undefined && origin !== facts.ownOrigin.toLowerCase();
}

/**
 * The decision, as a pure function over the facts of a request.
 *
 * Kept apart from the hook so every branch is unit-testable without a Fastify instance, and so the comparison
 * itself (`constantTimeEqual`, lengths first) has exactly one home.
 */
export function decideCsrf(facts: CsrfRequestFacts): CsrfVerdict {
  if (!isMutationMethod(facts.method)) return { ok: true };

  // Step 2 first: for the exempt routes it is the only half there is, and a cross-site request that happens to
  // carry a matching token pair is still a cross-site request.
  if (isCrossSite(facts)) return { ok: false, reason: 'cross-site' };

  if (isCsrfExempt(facts.path)) return { ok: true };

  const { cookieToken, headerToken } = facts;
  if (cookieToken === undefined || cookieToken === '' || headerToken === undefined) {
    return { ok: false, reason: 'missing-token' };
  }
  if (!constantTimeEqual(cookieToken, headerToken)) {
    return { ok: false, reason: 'token-mismatch' };
  }
  return { ok: true };
}

/** The facts {@link ownOriginOf} needs, kept apart from Fastify so the rule is testable with an object. */
export interface OwnOriginFacts {
  /** The protocol Fastify resolved for the request (`http` or `https`). */
  readonly protocol: string;
  /** The `Host` header, which is where the origin comes from unless a proxy is in the picture. */
  readonly host?: string | undefined;
  /** `X-Forwarded-Host`, verbatim — a comma list is legal, and {@link lastHeaderValue} is why. */
  readonly forwardedHost?: string | undefined;
  /** `X-Forwarded-Proto`, verbatim. */
  readonly forwardedProto?: string | undefined;
  /** `env.TRUST_PROXY`: the operator's statement that the client in front of us is *our* proxy. */
  readonly trustProxy?: boolean;
}

/**
 * This server's own origin — the value an `Origin` has to equal for a mutation to count as same-origin.
 *
 * Normally that is `protocol` + `Host`, and it is worth saying out loud why that is safe: a browser puts the
 * real authority in `Host`, and no page can arrange for a request to arrive with `Host` set to somewhere other
 * than the API it is calling. The one thing that *can* rewrite `Host` is a proxy the operator installed, and a
 * rewrite is exactly what makes a same-origin browser request *look* cross-site — nginx's default
 * `proxy_set_header Host $proxy_host` does it, and until PR-07's review so did this repo's own dev proxy
 * (`changeOrigin: true` answered `/api` with `Host: 127.0.0.1:3000` against
 * `Origin: http://localhost:5173`, i.e. `403` on every mutation of the dev SPA) — which is why
 * `apps/web/vite.config.ts` now pins that flag to `false`.
 *
 * Under `TRUST_PROXY` the forwarded pair therefore wins, and that is the same trust the repository already
 * places in the flag: `env.ts` refuses to boot in production with `TRUST_PROXY` and non-`Secure` cookies
 * because the flag means "TLS is terminated upstream", and `http/rate-limit.ts` takes the login window's IP
 * half from `X-Forwarded-For`. It does not open the CSRF door either, because the requests this half exists to
 * refuse arrive from *the victim's browser*, and a browser cannot set `X-Forwarded-Host` (forbidden header
 * name) while it always tells the truth about `Origin`. Two rules are not accidents:
 *
 * * the **last** value of a comma-separated forwarded header wins, since a proxy that appends writes the value
 *   it saw *after* whatever the client sent, so the leftmost entry is the least trustworthy one;
 * * a forwarded scheme that is not `http`/`https` is ignored rather than believed.
 *
 * A forwarded host that is not a host at all (`notes.example/path`, `not a host`) can only cause refusals:
 * `isCrossSite` parses the *client's* origin and compares exact strings, so a malformed own-origin matches
 * nothing. Failing closed is the right direction for a value this process does not own.
 */
export function ownOriginOf(facts: OwnOriginFacts): string {
  const trusted = facts.trustProxy ?? false;
  const host = (trusted ? lastHeaderValue(facts.forwardedHost) : undefined) ?? facts.host ?? 'localhost';
  const scheme =
    (trusted ? forwardedScheme(lastHeaderValue(facts.forwardedProto)) : undefined) ?? facts.protocol;
  return `${scheme}://${host}`.toLowerCase();
}

/** The last value of a comma-separated forwarded header, trimmed, or `undefined` when there is nothing. */
function lastHeaderValue(value: string | undefined): string | undefined {
  const parts = value?.split(',');
  const last = parts?.[parts.length - 1]?.trim();
  return last === undefined || last === '' ? undefined : last;
}

/** A forwarded scheme worth building an origin from, or `undefined` to fall back to the request's own. */
function forwardedScheme(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scheme = value.toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : undefined;
}

/** The path only: `isCsrfExempt` compares route paths, and a query string is not part of one. */
function pathOnly(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/** The sentence every refusal sends — one code, no hint about which half failed. */
const CSRF_FORBIDDEN_MESSAGE =
  'the CSRF check failed (stale or missing X-CSRF-Token, or a cross-origin request)';

/** What `buildApp()` hands the guard, so this module never reaches for `env.ts` itself. */
export interface CsrfGuardOptions {
  /** `env.TRUST_PROXY` — {@link ownOriginOf} explains what that flag is trusted to mean here. */
  readonly trustProxy?: boolean;
}

/**
 * Installs the guard on an instance.
 *
 * `onRequest` rather than `preHandler`, so a mutation that fails CSRF never reaches a route and never has its
 * body parsed: the refusal is not about the body. And registered app-wide — a function `buildApp()` calls, not
 * a nested plugin — so no route can later be added inside a scope that quietly skipped it.
 *
 * `trustProxy` arrives as a parameter rather than being read here, because only `env.ts` reads the environment
 * (PR-01) and `buildApp()` passes down what it parsed; a test that wants the forwarded behaviour therefore says
 * so in its own call rather than by setting a variable.
 */
export function registerCsrfGuard(app: FastifyInstance, options: CsrfGuardOptions = {}): void {
  const trustProxy = options.trustProxy ?? false;

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const verdict = decideCsrf({
      method: request.method,
      path: pathOnly(request.url),
      ownOrigin: ownOriginOf({
        protocol: request.protocol,
        host: request.headers.host,
        forwardedHost: request.headers['x-forwarded-host']?.toString(),
        forwardedProto: request.headers['x-forwarded-proto']?.toString(),
        trustProxy,
      }),
      cookieToken: request.cookies[CSRF_COOKIE_NAME],
      headerToken: request.headers[CSRF_HEADER_NAME.toLowerCase()]?.toString(),
      origin: request.headers.origin,
      secFetchSite: request.headers['sec-fetch-site'],
    });
    if (verdict.ok) return;

    // The reason is a log field and not a response field; the two token values are neither.
    request.log.debug({ csrfReject: verdict.reason, method: request.method }, 'CSRF request refused');
    throw new ForbiddenError(CSRF_FORBIDDEN_MESSAGE);
  });
}
