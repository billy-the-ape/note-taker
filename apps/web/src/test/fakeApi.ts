/**
 * A `fetch` that answers from a table, and the response bodies this app's schemas accept
 * (docs/plans/mvp/MVP-08.md §7).
 *
 * It stubs the network rather than mocking `lib/api.ts`, because the point of PR-08's tests is the
 * whole path a session takes: the real wrapper (CSRF header, envelope decoding, `Retry-After`), the
 * real contract schemas parsing the body, the real `QueryClient`, the real guards. Mocking the client
 * would test the shape of this PR's own assumptions instead.
 *
 * Answers are `Response` objects, so a status, a `content-type` and a header all behave the way they
 * do against a server — which is how the `429`/`Retry-After` test can be worth writing.
 */
import type { ApiErrorCode } from '@note-taker/contracts';
import type { FetchLike } from '../lib/api';

/** A handler's answer, in the shape `fetch` would have returned. */
export interface Reply {
  readonly status: number;
  /** Serialised as JSON with a `content-type` of its own. Omit for a `204`. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** One recorded request, in the order they were made. */
export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export type Stub = (request: { method: string; path: string; body: unknown }) => Reply;

export interface FakeApi {
  readonly fetch: FetchLike;
  readonly calls: readonly Recorded[];
}

/**
 * `routes` is keyed by `` `${method} ${path}` `` — `'POST /api/auth/login'`. A request with no entry
 * answers `500 INTERNAL` on purpose: a test that asked a question nobody thought to ask should fail
 * loudly rather than silently receive `{}` and pass for the wrong reason.
 */
export function fakeApi(routes: Readonly<Record<string, Stub>>): FakeApi {
  const calls: Recorded[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = input.split('?')[0] ?? input;
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const stub = routes[`${method} ${path}`];
    if (stub === undefined) {
      return jsonReply({ status: 500, body: errorBody('INTERNAL', `no stub for ${method} ${path}`) });
    }
    return toResponse(stub({ method, path, body }));
  };

  return { fetch: fetchImpl, calls };
}

function toResponse(reply: Reply): Response {
  if (reply.body === undefined) {
    return new Response(null, { status: reply.status, headers: { ...reply.headers } });
  }
  return jsonReply(reply);
}

function jsonReply(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
  });
}

/** The PR-05 envelope (§9.1), so a failure test fails the way the server fails. */
export function errorBody(
  code: ApiErrorCode,
  message: string,
  extra: { readonly details?: readonly unknown[]; readonly data?: unknown; readonly requestId?: string } = {},
): unknown {
  return {
    error: {
      code,
      message,
      ...(extra.details === undefined ? {} : { details: extra.details }),
      ...(extra.data === undefined ? {} : { data: extra.data }),
      requestId: extra.requestId ?? 'req_test_0123456789abcdef0123456789abcd',
    },
  };
}

/** `SessionUser` (§9.2 #8) — the id has to be a UUID, because `sessionUserSchema` says so. */
export function sessionUser(
  overrides: { readonly username?: string; readonly role?: 'owner' | 'member' } = {},
) {
  return {
    id: '019a3b4c-5d6e-7f80-9123-456789abcdef',
    username: overrides.username ?? 'ada.lovelace',
    role: overrides.role ?? 'owner',
    displayName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** `GET /api/auth/status` (§9.2 #2). */
export function statusReply(needsSetup: boolean, registrationOpen = false): Reply {
  return { status: 200, body: { needsSetup, registrationOpen } };
}

/** `GET /api/auth/session` (§9.2 #8): `expiresAt` only ever accompanies a user. */
export function sessionReply(user: ReturnType<typeof sessionUser> | null = null): Reply {
  return {
    status: 200,
    body: user === null ? { user: null } : { user, expiresAt: '2999-01-01T00:00:00.000Z' },
  };
}

/** The `{user}` an accepted `setup`/`register`/`login` answers with (§9.2 #3–#5). */
export function authReply(user: ReturnType<typeof sessionUser> = sessionUser()): Reply {
  return { status: 200, body: { user } };
}
