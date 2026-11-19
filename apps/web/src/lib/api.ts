/**
 * The one fetch wrapper the SPA uses (docs/plans/mvp/MVP-05.md §5 and §9).
 *
 * Responsibilities, in the order the code below handles them:
 *
 * 1. **`X-CSRF-Token` on every mutation.** `note_csrf` is a non-`HttpOnly` cookie the server can
 *    read but the server cannot set twice in one session, so the browser hands the value back in this
 *    header. The three login-family routes are exempt (`isCsrfExempt`) because a visitor who has not
 *    signed in yet has no cookie to echo; PR-07 guards those with `Origin`/`Sec-Fetch-Site` instead.
 * 2. **The one-shot recovery.** A tab left open past `Max-Age` has a stale or missing cookie, and the
 *    honest fix is not to show a member a `403` forever: on a `403` from a mutation the client
 *    re-fetches `GET /api/auth/status` **once** (which re-issues the cookie, §10) and replays the
 *    mutation **once**. Never twice, so a genuine `403` cannot turn into a loop, and the error the
 *    caller sees is the second one — the real one.
 * 3. **`ApiError`.** Every failure is one, carrying the whole envelope: `code`, `message`, `details`,
 *    `data` and `requestId`. `data` is why PR-14's autosave engine can read a `VERSION_CONFLICT`
 *    payload without re-fetching the note it just failed to save.
 * 4. **The 401 hook.** Session expiry is a single app-wide decision (route to the sign-in screen), so
 *    it is a callback the composition root sets rather than something each caller re-implements.
 *
 * Nothing here touches `document` at import time: the cookie reader is injected, which is also what
 * lets the suite below run in the plain Node environment Vitest uses.
 */
import {
  API_ERROR_MESSAGES,
  type ApiErrorCode,
  apiErrorCodeForStatus,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type ErrorData,
  type ErrorDetail,
  errorResponseSchema,
  isCsrfExempt,
  isMutationMethod,
  ROUTES,
} from '@note-taker/contracts';

/** A failure of the API, in the shape every non-2xx answer arrives in (§9.1). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Field errors, for a form to render under the input they came from. */
  readonly details?: readonly ErrorDetail[];
  /** The code-specific payload: `{ id }` on a duplicate create, `{ content, version }` on a stale write. */
  readonly data?: ErrorData;
  /** The server's request id, worth pasting into a support note when the message is not enough. */
  readonly requestId?: string;

  constructor(input: {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: readonly ErrorDetail[];
    readonly data?: ErrorData;
    readonly requestId?: string;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    if (input.details !== undefined) this.details = input.details;
    if (input.data !== undefined) this.data = input.data;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

/** The slice of `fetch` this module uses; a test passes a stub with the same shape. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** How the token is read back out of the cookie jar. Injectable so the wrapper stays DOM-free. */
export type CsrfTokenReader = () => string | undefined;

/**
 * The part of a Zod schema this client needs. A caller hands over the schema from
 * `@note-taker/contracts`, so a response is validated against the same contract the server compiled
 * against — and the return type follows it instead of being asserted.
 */
export interface ResponseParser<T> {
  parse(data: unknown): T;
}

export interface ApiCallOptions {
  /** Defaults to `GET`; anything in `MUTATION_METHODS` gets the CSRF header. */
  readonly method?: string;
  /** Serialised as JSON when present. `POST`/`PUT` bodies are objects, never pre-stringified strings. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ApiJsonOptions<T> extends ApiCallOptions {
  /** Validate the body and return its type instead of `unknown`. */
  readonly schema?: ResponseParser<T>;
}

export interface ApiClientOptions {
  /**
   * Prefix for every request. Empty by default: `ROUTES` already spell `/api`, and in development
   * Vite proxies that path to the API (§4 of the plan), so same-origin is the whole configuration.
   */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly readCsrfToken?: CsrfTokenReader;
  /** Called once per failed request, on the way to throwing. PR-08 wires it to the sign-in route. */
  readonly onUnauthorized?: (error: ApiError) => void;
}

export interface ApiClient {
  /** The token that would go in the header right now, or `undefined` when there is no cookie. */
  readonly csrfToken: () => string | undefined;
  /**
   * Sends the request and resolves with the raw `Response` — for `204` endpoints the caller still
   * wants to know it happened. Applies the CSRF rules and the one-shot recovery; throws `ApiError`
   * for every non-2xx.
   */
  readonly request: (path: string, options?: ApiCallOptions) => Promise<Response>;
  /**
   * `request()` plus the JSON decode. An empty body (`204`, and the other `DELETE`s of §9.2) resolves
   * with `undefined`; a `2xx` body that is not JSON is a server bug and arrives as an `ApiError`.
   */
  readonly json: <T = unknown>(path: string, options?: ApiJsonOptions<T>) => Promise<T>;
}

const JSON_ACCEPT = { accept: 'application/json; charset=utf-8' } as const;

/**
 * Reads `note_csrf` out of a `Cookie`/`document.cookie` string.
 *
 * Exported because it is the one part of the cookie story that is a pure function, and because a
 * reader built on `document.cookie` cannot be tested outside a browser. Values are base64url (no `;`
 * or `=` padding), so a plain split needs no unescaping beyond what `trim` does.
 */
export function csrfTokenFromCookie(cookie: string): string | undefined {
  for (const pair of cookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== CSRF_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    // An expired-away cookie is present but empty; treat that as "no token" rather than sending "".
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** The default reader: whatever the browser currently has, or nothing at all outside a browser. */
function readCsrfTokenFromDocument(): string | undefined {
  return typeof document === 'undefined' ? undefined : csrfTokenFromCookie(document.cookie);
}

function errorMessageFor(status: number): { readonly code: ApiErrorCode; readonly message: string } {
  const code = apiErrorCodeForStatus(status) ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION');
  return { code, message: API_ERROR_MESSAGES[code] };
}

function isJsonContent(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes('application/json') ?? false;
}

/**
 * Turns a failed `Response` into an `ApiError`.
 *
 * The body is read once and only once. A body that is not an envelope is not a crash: a proxy page,
 * a gateway `502`, or Fastify's own HTML answer to a request that never reached a route all become an
 * `ApiError` with the code that fits the status, so callers have exactly one failure type to catch.
 */
async function apiErrorFrom(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => '');

  const parsed: unknown = isJsonContent(response.headers.get('content-type'))
    ? safeJsonParse(raw)
    : undefined;
  const envelope = parsed === undefined ? undefined : errorResponseSchema.safeParse(parsed);
  if (envelope?.success) {
    const error = envelope.data.error;
    return new ApiError({
      status: response.status,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.data === undefined ? {} : { data: error.data }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    });
  }

  const fallback = errorMessageFor(response.status);
  const requestId = response.headers.get('x-request-id');
  return new ApiError({
    status: response.status,
    code: fallback.code,
    message: fallback.message,
    ...(requestId === null ? {} : { requestId }),
  });
}

function safeJsonParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Builds a client. Tests inject `fetch` and `readCsrfToken`; the app uses the exported `api` below and
 * injects nothing.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const readToken = options.readCsrfToken ?? readCsrfTokenFromDocument;

  function headersFor(method: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { ...JSON_ACCEPT };
    if (hasBody) headers['content-type'] = 'application/json; charset=utf-8';
    if (needsCsrfHeader(method)) {
      const token = readToken();
      // Absent is sent absent: the first `403` is what triggers the recovery below, and a request that
      // quietly dropped the header would look like a different bug.
      if (token !== undefined) headers[CSRF_HEADER_NAME] = token;
    }
    return headers;
  }

  /**
   * `POST`/`PUT`/`PATCH`/`DELETE` (§9.3): the header is attached to every mutation, including the three
   * login-family routes, because §9 says the client echoes the cookie on mutations and a stray header
   * on `POST /api/auth/login` is harmless. What the exempt routes change is the *consequence*: a `403`
   * there is a real answer rather than a stale cookie, so the recovery below skips them.
   */
  function needsCsrfHeader(method: string): boolean {
    return isMutationMethod(method);
  }

  /**
   * Re-fetches the route that re-issues `note_csrf` (§10). The body is discarded on purpose: this call
   * exists for its `Set-Cookie`, and PR-08 fetches the status for its own sake elsewhere.
   */
  async function refetchCsrfCookie(signal?: AbortSignal): Promise<void> {
    try {
      const response = await fetchImpl(`${baseUrl}${ROUTES.auth.status}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { ...JSON_ACCEPT },
        ...(signal === undefined ? {} : { signal }),
      });
      await response.text();
    } catch {
      // A refresh that never reached the server is not the error the caller cares about: the replay
      // that follows still answers on its own, and its `403` is the one worth surfacing.
    }
  }

  async function send(
    path: string,
    callOptions: ApiCallOptions | undefined,
    attempt: 0 | 1,
  ): Promise<Response> {
    const method = callOptions?.method ?? 'GET';
    const body = callOptions?.body;
    const signal = callOptions?.signal;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: 'same-origin',
      headers: headersFor(method, body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (response.ok) return response;

    // Built before anything is decided, so the 403 path and the thrown error cannot disagree.
    const error = await apiErrorFrom(response);

    // The one-shot CSRF refresh-and-replay: one refetch, one replay, no loop. `isCsrfExempt` is
    // re-checked so a `403` from `POST /api/auth/login` (registration closed) stays the real answer.
    if (error.status === 403 && attempt === 0 && needsCsrfHeader(method) && !isCsrfExempt(path)) {
      await refetchCsrfCookie(signal);
      return send(path, callOptions, 1);
    }

    if (error.status === 401) options.onUnauthorized?.(error);
    throw error;
  }

  async function request(path: string, callOptions?: ApiCallOptions): Promise<Response> {
    return send(path, callOptions, 0);
  }

  async function json<T = unknown>(path: string, callOptions?: ApiJsonOptions<T>): Promise<T> {
    const response = await request(path, callOptions);
    const raw = await response.text();
    if (raw.length === 0) {
      // `204` for the logout/delete/password endpoints of §9.2 (#6, #7, #9, #15, #20).
      return undefined as T;
    }

    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      // A 2xx that is not JSON means something between here and the app replaced the response; report
      // it as the server's fault rather than letting a SyntaxError escape.
      const requestId = response.headers.get('x-request-id');
      throw new ApiError({
        status: response.status,
        code: 'INTERNAL',
        message: API_ERROR_MESSAGES.INTERNAL,
        ...(requestId === null ? {} : { requestId }),
      });
    }

    const schema = callOptions?.schema;
    return schema === undefined ? (parsed as T) : schema.parse(parsed);
  }

  return { csrfToken: readToken, request, json };
}

/**
 * The client the components use. `onUnauthorized` is set here (not per call) by whoever owns routing,
 * so PR-08 can wire it once in the composition root.
 */
export const api = createApiClient();
