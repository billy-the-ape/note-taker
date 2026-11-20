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
 *    it is on every single time.
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
  /** This server's own origin, e.g. `http://localhost:3000`, from the request's own `Host`. */
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

/** The origin a request claims to belong to, from its own protocol and `Host` header. */
function originOf(request: FastifyRequest): string {
  const host = request.headers.host ?? 'localhost';
  return `${request.protocol}://${host}`.toLowerCase();
}

/** The path only: `isCsrfExempt` compares route paths, and a query string is not part of one. */
function pathOnly(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/** The sentence every refusal sends — one code, no hint about which half failed. */
const CSRF_FORBIDDEN_MESSAGE =
  'the CSRF check failed (stale or missing X-CSRF-Token, or a cross-origin request)';

/**
 * Installs the guard on an instance.
 *
 * `onRequest` rather than `preHandler`, so a mutation that fails CSRF never reaches a route and never has its
 * body parsed: the refusal is not about the body. And registered app-wide — a function `buildApp()` calls, not
 * a nested plugin — so no route can later be added inside a scope that quietly skipped it.
 */
export function registerCsrfGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const verdict = decideCsrf({
      method: request.method,
      path: pathOnly(request.url),
      ownOrigin: originOf(request),
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
