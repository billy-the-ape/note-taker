/**
 * Reading `Set-Cookie` off an injected response (PR-07's route tests).
 *
 * `light-my-request` hands back the headers as Node writes them, so `set-cookie` is an array of raw strings —
 * and the raw string is exactly what the acceptance criteria are written against ("`HttpOnly`, `SameSite=Lax`,
 * `Path=/`, `Secure`/`Max-Age` **on the responses**"). A parsed cookie jar would hide the thing under test: a
 * missing `HttpOnly` and a `HttpOnly` that the parser defaulted both look identical in a jar, and only one of
 * them is a bug.
 *
 * So this file deliberately does the smallest possible amount: split a header into its name, value and
 * attributes, and let the test assert on the attribute map.
 */
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@note-taker/contracts';

/** One `Set-Cookie` header, as the browser would receive it. */
export interface SetCookie {
  readonly name: string;
  readonly value: string;
  /** Attribute name (as written, lower-cased) → its value, or `true` for a valueless attribute. */
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * Every `Set-Cookie` header on a response, in the order the server wrote them.
 *
 * The parameter is `Record<string, unknown>` rather than the `OutgoingHttpHeaders` of the caller's response
 * because that is what Node gives back — a bag whose values may be a string, an array, or a number — and this
 * function's job is to say which of those it understood. A narrower signature would force every test to cast.
 */
export function setCookies(response: { headers: Record<string, unknown> }): SetCookie[] {
  const raw = response.headers['set-cookie'];
  const headers = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter(isString) : [];
  return headers.map(parseSetCookie);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Parses one `Set-Cookie` header.
 *
 * Deliberately hand-rolled rather than pulled from `@fastify/cookie`'s `parse`: the library's parser is lenient
 * in ways that would hide a server bug (a duplicated attribute, an unquoted value), and this file's whole job is
 * to be unlenient about the flags.
 */
export function parseSetCookie(header: string): SetCookie {
  const [nameAndValue, ...withAttributes] = header.split(';');
  const separator = nameAndValue?.indexOf('=') ?? -1;
  const attributes = new Map<string, string>();
  for (const part of withAttributes) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) attributes.set(trimmed.toLowerCase(), 'true');
    else attributes.set(trimmed.slice(0, equals).trim().toLowerCase(), trimmed.slice(equals + 1).trim());
  }
  if (nameAndValue === undefined || separator === -1) {
    throw new Error(`not a Set-Cookie header: ${header}`);
  }
  return {
    name: nameAndValue.slice(0, separator),
    value: nameAndValue.slice(separator + 1),
    attributes,
  };
}

/** The one `Set-Cookie` for `name`, or the last one if the response wrote it twice. */
export function findCookie(response: Parameters<typeof setCookies>[0], name: string): SetCookie | undefined {
  return setCookies(response)
    .filter((cookie) => cookie.name === name)
    .at(-1);
}

/** Just the value the server sent for `name` — the raw session token, in practice. */
export function cookieValue(response: Parameters<typeof setCookies>[0], name: string): string | undefined {
  return findCookie(response, name)?.value;
}

/**
 * A `Cookie` request header out of the values a test is holding.
 *
 * `undefined` entries are dropped rather than serialised as empty: `note_csrf=` is a cookie with an empty value,
 * which the CSRF guard refuses for a different reason than an absent cookie, and a test that means "absent" has
 * to say so by not passing one.
 */
export function cookieHeader(values: Readonly<Record<string, string | undefined>>): string | undefined {
  const pairs = Object.entries(values).filter((pair): pair is [string, string] => pair[1] !== undefined);
  return pairs.length === 0 ? undefined : pairs.map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The attributes the acceptance criteria name, as one object a test can compare wholesale. */
export function attributeSummary(cookie: SetCookie): Record<string, string | undefined> {
  const get = (name: string): string | undefined => cookie.attributes.get(name);
  return {
    name: cookie.name,
    domain: get('domain'),
    path: get('path'),
    expires: get('expires'),
    maxAge: get('max-age'),
    secure: get('secure'),
    httpOnly: get('httponly'),
    sameSite: get('samesite'),
  };
}

/**
 * The two cookies a test is holding after a response.
 *
 * A test-thread value, not a jar a browser would send: `note_session` and `note_csrf` are the only two cookies
 * this app writes, so a two-field record states the whole state and a `Map` would only hide which one is `undefined`.
 */
export interface Jar {
  /** The raw session token, exactly as the server sent it — the database has only its digest. */
  readonly session?: string | undefined;
  readonly csrf?: string | undefined;
}

/**
 * The jar as it stands after `response`, keeping whatever `response` did not mention.
 *
 * "Did not mention" matters: `clearSessionCookie` writes `note_session=` with an expiry in the past, and a helper
 * that treated that as "no session cookie" would be doing the browser's job rather than the test's. Both are the
 * same string here, so the tests that care assert on the header, and the ones that thread a session through a
 * flow just want the newest value that can authenticate.
 */
export function jarAfter(response: Parameters<typeof setCookies>[0], previous: Jar = {}): Jar {
  const next: { session?: string | undefined; csrf?: string | undefined } = { ...previous };
  for (const cookie of setCookies(response)) {
    const expired =
      cookie.attributes.get('max-age') === '0' || cookie.attributes.get('expires')?.includes('1970');
    const value = expired ? undefined : cookie.value;
    if (cookie.name === SESSION_COOKIE_NAME) next.session = value;
    if (cookie.name === CSRF_COOKIE_NAME) next.csrf = value;
  }
  return next;
}

/**
 * The headers a request out of this jar carries: `Cookie`, and `X-CSRF-Token` when the jar has a token.
 *
 * Omitting the header when there is no token is the point — it is how a test expresses "the client has not
 * fetched the cookie yet", which the guard answers differently from a mismatch.
 */
export function jarHeaders(jar: Jar, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const cookie = cookieHeader({
    [SESSION_COOKIE_NAME]: jar.session,
    [CSRF_COOKIE_NAME]: jar.csrf,
  });
  if (cookie !== undefined) headers.cookie = cookie;
  if (jar.csrf !== undefined) headers[CSRF_HEADER_NAME.toLowerCase()] = jar.csrf;
  return headers;
}
