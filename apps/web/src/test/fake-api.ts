/**
 * An in-process fake of the routes PR-16 talks to, for component tests (docs/plans/mvp/MVP-16.md §6).
 *
 * It exists because the acceptance criteria are about *sessions*, and a session is a fact about a
 * cookie jar plus a database row:
 *
 * * a password change rotates the acting session and keeps it, so the tab that made the call must
 *   find its way to the **new** token the way a browser does — by obeying `Set-Cookie` — and then be
 *   able to read its own user back from `GET /api/auth/session`;
 * * every **other** session of that user is deleted, so a second jar holding the old token has to be
 *   answered `401` by its next guarded request;
 * * `POST /api/auth/logout-all` deletes this jar's row too.
 *
 * A stubbed `fetch` that only returned canned bodies could not express any of that, and neither
 * could a mock of `lib/api.ts` — the point of these tests is the interaction between the client, the
 * cookie jar and the route semantics, so the whole transport is real: `createApiClient` from
 * `lib/api.ts` runs above the fake `fetch` below, including the envelope decoding and `ApiError`s.
 *
 * **What it is not.** It is not the server, and it does not prove PR-07's transaction. The
 * server-side proof is PR-07's own integration suite
 * (`apps/server/src/routes/auth.routes.int.test.ts`: "kills the old password, keeps this session
 * alive, and deletes every other one"). This file pins the same documented semantics from the
 * client's side, which is the half PR-16 owns; keep the two in step if `docs/API.md` #7 or #9 ever
 * changes.
 *
 * Two limits worth naming rather than discovering later. It does **not** model the CSRF cookie or
 * header — `readCsrfToken()` is a constant, so a missing or stale `X-CSRF-Token` on these `POST`s is
 * not something a PR-16 test could catch (PR-07's guard and PR-08's wiring own that), and unlike the
 * real routes it re-issues no CSRF cookie on `logout-all` (#7). The credential rules it *does* mirror
 * are the ones the tests turn on: `changePasswordSchema` for the shape, and the plan §10 username
 * rule the real route derives from the session through `changePasswordBodySchemaFor` — here against
 * the fake's own one user, which is the same fact from the other side.
 */
import {
  type ApiErrorCode,
  apiErrorCodeForStatus,
  changePasswordSchema,
  errorResponseBody,
  patchSettingsSchema,
  ROUTES,
  SESSION_COOKIE_NAME,
  type SessionResponse,
  type SessionUser,
  type Settings,
} from '@note-taker/contracts';

import { type ApiClient, createApiClient } from '../lib/api.js';

/** A session row, reduced to what the client can observe: its token. */
interface FakeSessionRow {
  readonly id: string;
  token: string;
  readonly userId: string;
}

export interface FakeServerOptions {
  /** The account's current password. Defaults to {@link FAKE_PASSWORD}. */
  readonly password?: string;
  /** The settings row that exists at boot. Omit it to model an account PR-09 has not written one for. */
  readonly settings?: Settings;
  readonly user?: SessionUser;
}

export interface FakeTab {
  /** The name is only for failure messages: "tab A did not expect that answer". */
  readonly name: string;
  /** A client whose requests carry this tab's cookies, the way one browser tab carries one jar. */
  readonly client: ApiClient;
  /** The session token the jar currently holds, which the rotation in `POST /api/auth/password` moves. */
  token(): string | undefined;
}

export interface FakeServer {
  /** A new browser tab: a fresh cookie jar plus a client bound to it. */
  tab(name?: string): FakeTab;
  /** Signs a tab in by handing it a session cookie, i.e. what `POST /api/auth/login` would have done. */
  signInTab(tab: FakeTab): void;
  /** The settings row as the "database" holds it — `undefined` until get-or-create has run. */
  settings(): Settings | undefined;
  /** The tokens with a live row: the assertion "every other session is deleted" is written against. */
  liveTokens(): readonly string[];
  /** Password the account answers with right now. */
  password(): string;
  /** Makes the next `PATCH /api/settings` fail, to exercise the optimistic rollback. */
  failNextPatch(failure: { readonly status: number; readonly message: string }): void;
  /** The one route the fake refuses on purpose, so a test can drive the page's error state. */
  failNextSettingsRead(failure: { readonly status: number; readonly message: string }): void;
  /** The requests the fake answered, in order: `PATCH /api/settings` and friends. */
  requests(): readonly string[];
  /**
   * Stops the next `PATCH /api/settings` in flight until `release` is called — the only honest way to
   * assert that a change took effect *before* the server answered, which is what "effective
   * immediately" means (MVP-16 §5) when the value lives on a server.
   */
  holdNextPatch(): {
    release(): void;
  };
}

export const FAKE_PASSWORD = 'correct-horse-battery';
export const FAKE_NEW_PASSWORD = 'a-brand-new-password-1';

const USER: SessionUser = {
  id: '3f0f8f6a-6f1d-4f0a-9f2f-7b1c2d3e4f50',
  username: 'ada.lovelace',
  role: 'owner',
  displayName: 'Ada Lovelace',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** The row `GET /api/settings` get-or-creates for an account that never had one (PR-09, MVP-16 §6). */
export const SERVER_DEFAULT_SETTINGS: Settings = {
  autosave: true,
  theme: 'system',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function jsonResponse<T>(body: T, status = 200, setCookie?: readonly string[]): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const cookie of setCookie ?? []) {
    headers.append('set-cookie', cookie);
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function noContentResponse(setCookie?: readonly string[]): Response {
  const headers = new Headers();
  for (const cookie of setCookie ?? []) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 204, headers });
}

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message?: string,
  details?: readonly { path: string; message: string }[],
): Response {
  return jsonResponse(
    errorResponseBody({
      code,
      ...(message === undefined ? {} : { message }),
      ...(details === undefined ? {} : { details }),
    }),
    status,
  );
}

/** The `Path=/` cookie a browser would store, or drop when the value is empty. */
function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax`;
}

/** Reads this fake's own `Set-Cookie` header, the way a browser would. */
function applySetCookie(headers: Headers, jar: Map<string, string>): void {
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(';');
    if (pair === undefined) continue;
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value.length === 0) jar.delete(name);
    else jar.set(name, value);
  }
}

let tokenCounter = 0;
function newToken(): string {
  tokenCounter += 1;
  return `tok-${tokenCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const state = {
    password: options.password ?? FAKE_PASSWORD,
    settings: options.settings === undefined ? undefined : { ...options.settings },
    user: options.user ?? USER,
    /** One deliberate failure per call, so a test asks for exactly the failure it is proving. */
    patchFailure: undefined as { status: number; message: string } | undefined,
    readFailure: undefined as { status: number; message: string } | undefined,
  };
  const sessions: FakeSessionRow[] = [];
  const log: string[] = [];
  /** Set by `holdNextPatch`; the fetch awaits it, so the request stays in flight. */
  let patchGate: { promise: Promise<void>; release: () => void } | undefined;

  function tokenFor(jar: Map<string, string>): string | undefined {
    return jar.get(SESSION_COOKIE_NAME);
  }

  function rowFor(jar: Map<string, string>): FakeSessionRow | undefined {
    const token = tokenFor(jar);
    return sessions.find((row) => row.token === token);
  }

  function unauthorized(): Response {
    return errorResponse(401, 'UNAUTHORIZED', 'you are not signed in');
  }

  function handle(path: string, method: string, body: unknown, jar: Map<string, string>): Response {
    // The body is in the log because "the toggle sent `{autosave:false}`" is an assertion worth
    // writing, and a fake that hides its own traffic makes it un-writable.
    log.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);

    if (path === ROUTES.settings && (method === 'GET' || method === 'PATCH')) {
      if (rowFor(jar) === undefined) return unauthorized();

      if (method === 'GET') {
        const failure = state.readFailure;
        state.readFailure = undefined;
        if (failure !== undefined) {
          return errorResponse(
            failure.status,
            apiErrorCodeForStatus(failure.status) ?? 'INTERNAL',
            failure.message,
          );
        }
        // Get-or-create (PR-09): an account with no row is not a 404 and not an empty body.
        if (state.settings === undefined) {
          state.settings = { ...SERVER_DEFAULT_SETTINGS, updatedAt: new Date().toISOString() };
        }
        return jsonResponse(state.settings);
      }

      const parsed = patchSettingsSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, 'VALIDATION');
      }
      const failure = state.patchFailure;
      state.patchFailure = undefined;
      if (failure !== undefined) {
        return errorResponse(
          failure.status,
          failure.status >= 500 ? 'INTERNAL' : 'VALIDATION',
          failure.message,
        );
      }
      // Get-or-create on the write side too, so a `PATCH` racing the very first read is not an error.
      const current = state.settings ?? {
        ...SERVER_DEFAULT_SETTINGS,
        updatedAt: '1970-01-01T00:00:00.000Z',
      };
      state.settings = {
        autosave: parsed.data.autosave ?? current.autosave,
        theme: parsed.data.theme ?? current.theme,
        updatedAt: new Date().toISOString(),
      };
      return jsonResponse(state.settings);
    }

    if (path === ROUTES.auth.session && method === 'GET') {
      const row = rowFor(jar);
      // §9.2 #8 answers `{user:null}` rather than `401`, so `lib/api.ts`'s handler never loops.
      if (row === undefined) return jsonResponse<SessionResponse>({ user: null });
      return jsonResponse<SessionResponse>({
        user: state.user,
        expiresAt: '2026-02-01T00:00:00.000Z',
      });
    }

    if (path === ROUTES.auth.password && method === 'POST') {
      const row = rowFor(jar);
      if (row === undefined) return unauthorized();

      const payload = body as { currentPassword?: string; newPassword?: string };
      // `401` with that message is what PR-07 answers when the caller proved they were signed in but
      // not that they know the secret (auth.service.ts), and this form renders it inline.
      if (payload.currentPassword !== state.password) {
        return errorResponse(401, 'UNAUTHORIZED', 'the current password is not right');
      }
      const parsed = changePasswordSchema.safeParse({
        currentPassword: payload.currentPassword ?? '',
        newPassword: payload.newPassword ?? '',
      });
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        return errorResponse(400, 'VALIDATION', 'the request body is not valid', [
          {
            path: String((issue?.path[0] ?? 'newPassword') as string),
            message: String(issue?.message ?? ''),
          },
        ]);
      }
      // Plan §10, enforced server-side because the username comes from the session (docs/API.md #9).
      if (String(payload.newPassword).toLowerCase() === state.user.username.toLowerCase()) {
        return errorResponse(400, 'VALIDATION', 'the request body is not valid', [
          { path: 'newPassword', message: 'must not be the same as the username' },
        ]);
      }

      state.password = String(payload.newPassword);
      // One transaction: the acting row is rotated (same row, new token), every other row is deleted.
      const rotated = newToken();
      row.token = rotated;
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        const candidate = sessions[index];
        if (candidate !== undefined && candidate.id !== row.id) sessions.splice(index, 1);
      }
      return noContentResponse([sessionCookie(rotated)]);
    }

    if (path === ROUTES.auth.logoutAll && method === 'POST') {
      const row = rowFor(jar);
      if (row === undefined) return unauthorized();
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        if (sessions[index]?.userId === row.userId) sessions.splice(index, 1);
      }
      return noContentResponse([`${sessionCookie('')}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]);
    }

    return errorResponse(404, 'NOT_FOUND', `the fake does not implement ${method} ${path}`);
  }

  function makeTab(name: string): FakeTab {
    const jar = new Map<string, string>();

    const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
      const url = new URL(input, 'http://localhost');
      const method = init.method ?? 'GET';
      const gate = patchGate;
      if (gate !== undefined && method === 'PATCH' && url.pathname === ROUTES.settings) {
        // Held *before* it is handled, so the client is genuinely mid-request: no response body to
        // have refreshed the cache from, and no log entry yet.
        patchGate = undefined;
        await gate.promise;
      }
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const response = handle(url.pathname, method, body, jar);
      applySetCookie(response.headers, jar);
      return response;
    };

    const tab: FakeTab = {
      name,
      client: createApiClient({
        fetch: fetchImpl,
        // The CSRF cookie is PR-07's business and `lib/api.test.ts` covers the header and the
        // one-shot replay already; these tests are about sessions.
        readCsrfToken: () => 'fake-csrf-token',
      }),
      token: () => tokenFor(jar),
    };
    jarByTab.set(tab, jar);
    return tab;
  }

  return {
    tab(name = 'tab') {
      return makeTab(name);
    },
    signInTab(tab) {
      const row: FakeSessionRow = {
        id: `session-${sessions.length + 1}`,
        token: newToken(),
        userId: state.user.id,
      };
      sessions.push(row);
      // The tab learns the token from a `Set-Cookie`, exactly as it would from a login response —
      // `signInTab` is the login the fake does not implement, not a way to smuggle a token in.
      applySetCookie(new Headers({ 'set-cookie': sessionCookie(row.token) }), jarOf(tab));
    },
    settings: () => (state.settings === undefined ? undefined : { ...state.settings }),
    liveTokens: () => sessions.map((row) => row.token),
    password: () => state.password,
    failNextPatch(failure) {
      state.patchFailure = failure;
    },
    failNextSettingsRead(failure) {
      state.readFailure = failure;
    },
    requests: () => [...log],
    holdNextPatch() {
      let proceed: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      // The gate is handed back by identity, not looked up again: the fetch clears `patchGate` the
      // moment it picks the request up, and a `release()` that resolved through the server would then
      // be a no-op that hung the test instead of the request.
      const gate = { promise, release: () => proceed?.() };
      patchGate = gate;
      return gate;
    },
  };
}

/**
 * The jars are closed over by each tab, so they are reached through a WeakMap rather than exposed on
 * {@link FakeTab}: a test should not be able to hand a tab a token directly, because that is not a
 * thing a tab can do.
 */
const jarByTab = new WeakMap<object, Map<string, string>>();

function jarOf(tab: FakeTab): Map<string, string> {
  const jar = jarByTab.get(tab);
  if (jar === undefined) throw new Error(`the fake has no cookie jar for ${tab.name}`);
  return jar;
}
