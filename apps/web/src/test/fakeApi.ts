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

/**
 * One recorded request, in the order they were made.
 *
 * **Three fields, and they have to stay three.** This is the shape PR-08's and PR-15's tests deep-equality
 * against (`expect(fake.calls).toEqual([{ method, path, body }])`), so a fourth field here is a red `unit`
 * job in every PR that was merged before it. The full request target is recorded too — it is one field wider
 * and lives in {@link FakeApi.requests}, and a test that has to know whether `?cascade=true` was sent reads
 * that one. One recording, two views, no versioned assertion.
 */
export interface Recorded {
  readonly method: string;
  /** The path with its query string removed, which is what a route table is keyed by. */
  readonly path: string;
  readonly body: unknown;
}

/** What a stub is asked about: the same three facts, plus the url a query-parameter rule needs. */
export interface Requested {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly body: unknown;
}

/**
 * A route's answer.
 *
 * A stub may return a promise, which is how a test holds a request open. That is not a flourish: the
 * acceptance criteria are about a *sequence* — the tree changes optimistically, then the tree goes back — and
 * a fake that always answers immediately makes the first half unobservable, because React has painted nothing
 * by the time the rollback has already happened.
 */
export type Stub = (request: Requested) => Reply | Promise<Reply>;

export interface FakeApi {
  readonly fetch: FetchLike;
  /** The recorded requests as `{ method, path, body }`, in order — the shape a deep-equality test is written against. */
  readonly calls: readonly Recorded[];
  /**
   * The same requests in the same order, with the url. `path` cannot answer "did the client send
   * `?cascade=true`" (§9.2 #15) — after PR-12 that is a question about a deleted subtree, so it is worth
   * recording rather than reconstructing, and it is why this view exists rather than a field on
   * {@link Recorded}.
   */
  readonly requests: readonly Requested[];
}

/**
 * `routes` is keyed by `` `${method} ${path}` `` — `'POST /api/auth/login'`. A request with no entry
 * answers `500 INTERNAL` on purpose: a test that asked a question nobody thought to ask should fail
 * loudly rather than silently receive `{}` and pass for the wrong reason.
 *
 * `fallback` is consulted for a route the table does not contain, and it exists for the tree fake
 * (`test/treeApi.ts`): the ids inside `/api/folders/<id>` are only known at runtime, so a table keyed by
 * literal string can never hold them. An explicit entry still wins, which is what lets a test say "answer
 * *this* route differently today" without reimplementing the model behind it.
 */
export function fakeApi(
  routes: Readonly<Record<string, Stub>>,
  options: { readonly fallback?: Stub | undefined } = {},
): FakeApi {
  const requests: Requested[] = [];
  const fallback = options.fallback;

  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = input;
    const path = input.split('?')[0] ?? input;
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, url, body });

    const stub = routes[`${method} ${path}`] ?? fallback;
    if (stub === undefined) {
      return jsonReply({ status: 500, body: errorBody('INTERNAL', `no stub for ${method} ${path}`) });
    }
    return toResponse(await stub({ method, path, url, body }));
  };

  // `calls` is derived rather than stored, so the two views cannot drift and the historical shape is not a
  // second array somebody has to remember to append to.
  return {
    fetch: fetchImpl,
    requests,
    get calls(): readonly Recorded[] {
      return requests.map(({ method, path, body }) => ({ method, path, body }));
    },
  };
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
