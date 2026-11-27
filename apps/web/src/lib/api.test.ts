/**
 * The first web tests (docs/plans/mvp/MVP-05.md §11): a mocked `fetch`, no DOM, no server.
 *
 * What they pin, in order of how much it costs when it breaks:
 *
 * * the CSRF header is echoed from the cookie on every mutation and absent when there is no cookie;
 * * the one-shot recovery — **exactly one** `GET /api/auth/status`, **exactly one** replay, and a
 *   second `403` that surfaces instead of looping;
 * * `ApiError` carries the whole envelope, including `data`, which PR-14 reads;
 * * the `401` hook fires once per failure, on the way to throwing.
 */
import {
  API_ERROR_MESSAGES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  errorResponseBody,
  ROUTES,
  treeResponseSchema,
} from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError, createApiClient, csrfTokenFromCookie, type FetchLike } from './api';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * A `fetch` that answers from a queue and records what it was asked for. Answers are consumed in
 * order, so a test that expects three requests queues three responses; an empty queue is a hard
 * failure, which is what makes "exactly one replay" a real assertion rather than a hope.
 */
function mockFetch(responses: readonly (Response | Error)[]) {
  const calls: Recorded[] = [];
  const queue = [...responses];

  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`no stubbed response left for ${input}`);
    if (next instanceof Error) throw next;
    return next;
  };

  /** The value each recorded request carried for a header, in order, `null` when it sent none. */
  const headerValues = (name: string): (string | null)[] =>
    calls.map((call) => new Headers(call.init.headers).get(name));

  return { calls, fetch, headerValues };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

function envelope(
  status: number,
  code: 'FORBIDDEN' | 'UNAUTHORIZED' | 'VALIDATION' | 'NOT_FOUND' | 'INTERNAL',
) {
  return jsonResponse(errorResponseBody({ code, message: API_ERROR_MESSAGES[code] }), { status });
}

describe('csrfTokenFromCookie', () => {
  it('reads the token out of a cookie string, ignoring the rest of the jar', () => {
    expect(csrfTokenFromCookie(`note_session=session-value; ${CSRF_COOKIE_NAME}=AbC-123_x; other=1`)).toBe(
      'AbC-123_x',
    );
    expect(csrfTokenFromCookie(`${CSRF_COOKIE_NAME}=only`)).toBe('only');
  });

  it('treats a missing or empty value as no token, which is what a cleared cookie looks like', () => {
    expect(csrfTokenFromCookie('note_session=session-value')).toBeUndefined();
    expect(csrfTokenFromCookie('')).toBeUndefined();
    expect(csrfTokenFromCookie(`${CSRF_COOKIE_NAME}=`)).toBeUndefined();
    expect(csrfTokenFromCookie('no-separator-here')).toBeUndefined();
  });

  it('does not match a cookie whose name merely starts with the token cookie', () => {
    expect(csrfTokenFromCookie('note_csrf_dual=wrong')).toBeUndefined();
  });
});

describe('the CSRF header', () => {
  it('echoes the cookie value on a mutation', async () => {
    const fetch = mockFetch([jsonResponse({ folders: [], notes: [] }, { status: 201 })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-1' });

    await client.request(ROUTES.notes, { method: 'POST', body: { folderId: null } });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(ROUTES.notes);
    expect(fetch.calls[0]?.init.method).toBe('POST');
    expect(new Headers(fetch.calls[0]?.init.headers).get(CSRF_HEADER_NAME)).toBe('token-1');
    expect(fetch.calls[0]?.init.body).toBe('{"folderId":null}');
    expect(new Headers(fetch.calls[0]?.init.headers).get('content-type')).toContain('application/json');
    // Cookies carry the session, so the request has to be a credentialed one even same-origin.
    expect(fetch.calls[0]?.init.credentials).toBe('same-origin');
  });

  it('omits the header when there is no cookie to echo, rather than sending an empty value', async () => {
    const fetch = mockFetch([
      envelope(403, 'FORBIDDEN'),
      jsonResponse({ needsSetup: false, registrationOpen: false }),
      envelope(403, 'FORBIDDEN'),
    ]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    // The `403` recovery runs and fails; both attempts went out without the header, because there was
    // nothing to send and an empty `X-CSRF-Token` would read as a different bug than a missing one.
    await expect(client.request(ROUTES.notes, { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(fetch.headerValues(CSRF_HEADER_NAME)).toEqual([null, null, null]);
  });

  it('is not sent on a GET, which changes nothing', async () => {
    const fetch = mockFetch([jsonResponse({ folders: [], notes: [] })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-1' });

    await client.request(ROUTES.tree);
    expect(fetch.headerValues(CSRF_HEADER_NAME)).toEqual([null]);
  });

  it('honours a baseUrl, so a deployment behind a path prefix needs no other change', async () => {
    const fetch = mockFetch([jsonResponse({ user: null })]);
    const client = createApiClient({
      baseUrl: '/note-taker',
      fetch: fetch.fetch,
      readCsrfToken: () => undefined,
    });

    await client.request(ROUTES.auth.session);
    expect(fetch.calls[0]?.url).toBe(`/note-taker${ROUTES.auth.session}`);
  });
});

describe('keepalive, which only PR-14’s unload path asks for', () => {
  it('reaches fetch as keepalive and still carries the CSRF header', async () => {
    const fetch = mockFetch([jsonResponse({ id: 'n1', version: 8 })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-9' });

    await client.request(ROUTES.noteContent('n1'), {
      method: 'PUT',
      body: { content: 'text written on the way out', baseVersion: 7 },
      keepalive: true,
    });

    expect(fetch.calls[0]?.init.keepalive).toBe(true);
    // The header is the whole reason the unload path is a `fetch` and not `navigator.sendBeacon`,
    // which can only POST and cannot set it (docs/plans/mvp/MVP-14.md §6).
    expect(new Headers(fetch.calls[0]?.init.headers).get(CSRF_HEADER_NAME)).toBe('token-9');
  });

  it('is absent from every request that did not ask for it', async () => {
    const fetch = mockFetch([jsonResponse({ needsSetup: false, registrationOpen: false })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await client.request(ROUTES.auth.status);
    // Not `false`: `RequestInit.keepalive` is optional, and a wrapper that always sends it would
    // quietly move every request in the app onto the unload transport.
    expect(fetch.calls[0]?.init.keepalive).toBeUndefined();
  });
});

describe('ApiError', () => {
  it('carries the whole envelope, including the data a conflict client needs', async () => {
    const fetch = mockFetch([
      jsonResponse(
        errorResponseBody({
          code: 'VERSION_CONFLICT',
          message: 'someone saved this note first',
          details: [{ path: 'baseVersion', message: 'is stale' }],
          data: { content: 'the server text', version: 7 },
          requestId: 'req-7',
        }),
        { status: 409 },
      ),
    ]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    const error = await client.request(ROUTES.noteContent('n1'), { method: 'PUT' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.name).toBe('ApiError');
    expect(apiError).toBeInstanceOf(Error);
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('VERSION_CONFLICT');
    expect(apiError.message).toBe('someone saved this note first');
    expect(apiError.details).toEqual([{ path: 'baseVersion', message: 'is stale' }]);
    // PR-14 compares this pair against the snapshot it sent, without a second request.
    expect(apiError.data).toEqual({ content: 'the server text', version: 7 });
    expect(apiError.requestId).toBe('req-7');
  });

  it('falls back to the status when the body is not an envelope, so a proxy page is still one error type', async () => {
    const gateway = new Response('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    const fetch = mockFetch([gateway]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    const error = await client.request(ROUTES.tree).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL });
  });

  it('reads an unmapped 4xx as the code its status implies, not as an internal failure', async () => {
    const fetch = mockFetch([new Response('', { status: 404 })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await expect(client.request(ROUTES.note('n1'))).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: API_ERROR_MESSAGES.NOT_FOUND,
    });
  });

  it('picks up the request id from the header when the body did not carry one', async () => {
    const fetch = mockFetch([new Response('', { status: 429, headers: { 'x-request-id': 'req-9' } })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await expect(client.request(ROUTES.tree)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      requestId: 'req-9',
    });
  });

  it('carries Retry-After only when it is whole seconds, because a form has to say a number', async () => {
    // One helper, called once per header value, because the interesting half of this contract is what a
    // *proxy* answers rather than what this app sends.
    const retryAfter = async (header: string): Promise<number | undefined> => {
      const fetch = mockFetch([new Response('', { status: 429, headers: { 'retry-after': header } })]);
      const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

      const error = await client.request(ROUTES.tree).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return (error as ApiError).retryAfterSeconds;
    };

    expect(await retryAfter('45')).toBe(45);
    // `Number('Wed, 21 Oct …')` is `NaN`, and a `NaN` reaching the login form reads "try again in NaN s".
    expect(await retryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    // The contract is whole seconds (docs/API.md), and a fraction or a time already passed is not that.
    expect(await retryAfter('1.5')).toBeUndefined();
    expect(await retryAfter('-1')).toBeUndefined();
    // The divergence that would actually cost someone: `Number('1e3')` is a fine `1000`, so reading the
    // header arithmetically would report seventeen minutes from a value that is not `delay-seconds` at all.
    // The same is true of `+45`, `0x21`, `45.` and `-0`; one of them is enough to pin the shape.
    expect(await retryAfter('1e3')).toBeUndefined();
    // And the case `Number()` gets wrong on its own: an empty value survives `Headers.get()` (which trims,
    // but does not remove) and converts to `0`, i.e. an invitation to retry immediately on a response whose
    // whole point is "not yet".
    expect(await retryAfter('')).toBeUndefined();
  });
});

describe('the one-shot CSRF refresh-and-replay (§9)', () => {
  /**
   * A client whose cookie jar hands out `stale` for the first read and `fresh` afterwards, i.e. a tab
   * that just received a re-issued `note_csrf`.
   */
  function clientWithStaleCookie(fetch: FetchLike) {
    const tokens = ['stale', 'fresh'];
    return createApiClient({ fetch, readCsrfToken: () => tokens.shift() });
  }

  it('re-fetches the status once, replays once, and succeeds', async () => {
    const fetch = mockFetch([
      envelope(403, 'FORBIDDEN'),
      jsonResponse({ needsSetup: false, registrationOpen: false }),
      jsonResponse({ folders: [], notes: [] }, { status: 201 }),
    ]);
    const client = clientWithStaleCookie(fetch.fetch);

    const response = await client.request(ROUTES.notes, { method: 'POST', body: { name: 'plan.md' } });
    expect(response.status).toBe(201);

    expect(fetch.calls.map((call) => [call.url, call.init.method])).toEqual([
      [ROUTES.notes, 'POST'],
      [ROUTES.auth.status, 'GET'],
      [ROUTES.notes, 'POST'],
    ]);
    // The replay reads the cookie again, which is the only way the refreshed value is ever used.
    expect(fetch.headerValues(CSRF_HEADER_NAME)).toEqual(['stale', null, 'fresh']);
  });

  it('surfaces a second 403 rather than refreshing forever', async () => {
    const fetch = mockFetch([
      envelope(403, 'FORBIDDEN'),
      jsonResponse({ needsSetup: false, registrationOpen: false }),
      envelope(403, 'FORBIDDEN'),
    ]);
    const client = clientWithStaleCookie(fetch.fetch);

    await expect(client.request(ROUTES.notes, { method: 'POST' })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.calls.filter((call) => call.url === ROUTES.auth.status)).toHaveLength(1);
    expect(fetch.calls.filter((call) => call.url === ROUTES.notes)).toHaveLength(2);
  });

  it('replays even when the refresh request itself failed', async () => {
    const fetch = mockFetch([
      envelope(403, 'FORBIDDEN'),
      new Error('offline'),
      jsonResponse({ id: 'n1' }, { status: 201 }),
    ]);
    const client = clientWithStaleCookie(fetch.fetch);

    const response = await client.request(ROUTES.notes, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(fetch.calls).toHaveLength(3);
  });

  it('never treats a 403 from the login family as a stale cookie', async () => {
    const fetch = mockFetch([envelope(403, 'FORBIDDEN')]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-1' });

    // "Registration is closed" is the real answer (§9.2 #4); replaying it would only log a second 403.
    await expect(
      client.request(ROUTES.auth.login, { method: 'POST', body: { username: 'a', password: 'b' } }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it('does not apply to a GET, which never carries the header in the first place', async () => {
    const fetch = mockFetch([envelope(403, 'FORBIDDEN')]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-1' });

    await expect(client.request(ROUTES.tree)).rejects.toMatchObject({ status: 403 });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('the 401 hook', () => {
  it('fires once with the error, on the way to throwing, and not on a success', async () => {
    const seen: ApiError[] = [];
    const fetch = mockFetch([envelope(401, 'UNAUTHORIZED'), jsonResponse({ folders: [], notes: [] })]);
    const client = createApiClient({
      fetch: fetch.fetch,
      readCsrfToken: () => undefined,
      onUnauthorized: (error) => seen.push(error),
    });

    await expect(client.request(ROUTES.tree)).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.code).toBe('UNAUTHORIZED');

    await client.request(ROUTES.tree);
    expect(seen).toHaveLength(1);
  });

  it('stays quiet for a 401 that denies the credentials in the body, not the session (docs/API.md #9)', async () => {
    const seen: ApiError[] = [];
    const fetch = mockFetch([envelope(401, 'UNAUTHORIZED'), envelope(401, 'UNAUTHORIZED')]);
    const client = createApiClient({
      fetch: fetch.fetch,
      readCsrfToken: () => 'token-1',
      onUnauthorized: (error) => seen.push(error),
    });

    // `POST /api/auth/password` answers `401` for a wrong `currentPassword` while the session that
    // sent it stays alive (PR-07 rotates and keeps it), so this is the change-password form's inline
    // message, not an expiry. Firing the hook here is what used to bounce a person to `/login` for a
    // typo — see `isCredentialOnly401`, whose whole job is this line.
    await expect(
      client.json(ROUTES.auth.password, {
        method: 'POST',
        body: { currentPassword: 'what I thought it was', newPassword: 'a-brand-new-password-1' },
      }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(seen).toEqual([]);

    // The exemption is one route wide: the next `401`, from anywhere else, is still the app-wide
    // "the session is gone" event, and this is the assertion that keeps it that way.
    await expect(client.request(ROUTES.tree)).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveLength(1);
  });

  it('does not trigger the CSRF replay, because a new cookie would not help an expired session', async () => {
    const fetch = mockFetch([envelope(401, 'UNAUTHORIZED')]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => 'token-1' });

    await expect(client.request(ROUTES.notes, { method: 'POST' })).rejects.toMatchObject({ status: 401 });
    expect(fetch.calls).toHaveLength(1);
  });

  it('is optional, so a test or a script can use the client without one', async () => {
    const fetch = mockFetch([envelope(401, 'UNAUTHORIZED')]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });
    await expect(client.request(ROUTES.tree)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('json()', () => {
  it('parses the body, and validates it against the schema it is given', async () => {
    const body = { folders: [], notes: [] };
    const fetch = mockFetch([jsonResponse(body)]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    const tree = await client.json(ROUTES.tree, { schema: treeResponseSchema });
    expect(tree).toEqual(body);
    expect(tree.folders).toEqual([]);
  });

  it('resolves an empty 204 body with undefined, which is every DELETE of §9.2', async () => {
    const fetch = mockFetch([new Response(null, { status: 204 })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await expect(client.json(ROUTES.note('n1'), { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('reports a 2xx that is not JSON as the server’s fault, without a SyntaxError escaping', async () => {
    const fetch = mockFetch([
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await expect(client.json(ROUTES.tree)).rejects.toMatchObject({ status: 200, code: 'INTERNAL' });
  });

  it('surfaces a body that fails its schema, so a contract break is loud here rather than two screens away', async () => {
    const fetch = mockFetch([jsonResponse({ folders: 'not-an-array', notes: [] })]);
    const client = createApiClient({ fetch: fetch.fetch, readCsrfToken: () => undefined });

    await expect(client.json(ROUTES.tree, { schema: treeResponseSchema })).rejects.not.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('csrfToken()', () => {
  it('exposes the token a component may want to show or send itself', () => {
    const client = createApiClient({ readCsrfToken: () => csrfTokenFromCookie(`${CSRF_COOKIE_NAME}=abc`) });
    expect(client.csrfToken()).toBe('abc');
  });

  it('reports nothing when the browser has no such cookie', () => {
    const client = createApiClient({ readCsrfToken: () => csrfTokenFromCookie('') });
    expect(client.csrfToken()).toBeUndefined();
  });
});
