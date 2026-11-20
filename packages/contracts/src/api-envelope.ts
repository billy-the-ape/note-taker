/**
 * The HTTP envelope (docs/plans/mvp/MVP-05.md §6, plan §9.1).
 *
 * Every non-2xx answer from the API has this shape, and `apps/server/src/plugins/error-handler.ts`
 * is the only place that writes one — so the client can always read `error.code` and never has to
 * guess whether a `400` came from Fastify, Zod, Postgres or the app.
 *
 * This module also owns the transport constants both sides must agree on and never want to disagree
 * about (cookie and header names, which methods are mutations), because they belong to the same
 * contract as the status codes below.
 */
import { z } from 'zod';

/** The complete set of error codes (plan §9.1). Nothing may invent a tenth. */
export const API_ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'VERSION_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * The status each code answers with. `VERSION_CONFLICT` shares `409` with `CONFLICT` because the
 * HTTP status is not the discriminator — `code` is, and a sibling-name clash and a stale
 * `baseVersion` need different handling while both mean "your write does not apply to the current
 * state".
 */
export const API_ERROR_STATUS = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
} as const satisfies Record<ApiErrorCode, number>;

/** Sent when a caller gives no message; never a place-holder that hides the cause from a user. */
export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  VALIDATION: 'the request body is not valid',
  UNAUTHORIZED: 'you are not signed in',
  FORBIDDEN: 'you are not allowed to do that',
  NOT_FOUND: 'not found',
  CONFLICT: 'that conflicts with the current state',
  RATE_LIMITED: 'too many attempts, try again later',
  VERSION_CONFLICT: 'someone saved this note first',
  PAYLOAD_TOO_LARGE: 'that note is too large to save',
  INTERNAL: 'internal error',
};

/**
 * One field error. `details` stays a flat list of these — structured extras travel in `data`, which
 * is what keeps `details` renderable by a form without special cases.
 */
export const errorDetailSchema = z.object({
  /** Dotted request-body path, e.g. `name`, `folderId`, `password`. */
  path: z.string().min(1),
  message: z.string().min(1),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

/**
 * `CONFLICT` from a duplicate create (§9.3): the id of the row that already exists, so a
 * double-clicked "Create" adopts it instead of firing twice. Pinned here and in `docs/API.md`.
 */
export const conflictErrorDataSchema = z.strictObject({ id: z.string().min(1) });
export type ConflictErrorData = z.infer<typeof conflictErrorDataSchema>;

/**
 * `VERSION_CONFLICT` (§9.2 #18): the **current server plaintext plus its version** — the exact pair
 * PR-14's autosave engine compares against the snapshot it put on the wire. Pinned here and in
 * `docs/API.md`; PR-10 produces it, PR-14 reads it.
 */
export const versionConflictErrorDataSchema = z.strictObject({
  content: z.string(),
  version: z.number().int().nonnegative(),
});
export type VersionConflictErrorData = z.infer<typeof versionConflictErrorDataSchema>;

/**
 * `data` on the wire: an optional, code-specific payload object. Unknown keys are tolerated so a
 * later PR can add a variant without a breaking change to every reader; the two known shapes are
 * narrowed by {@link isConflictErrorData} and {@link isVersionConflictErrorData}.
 */
export const errorDataSchema = z.record(z.string(), z.unknown());
export type ErrorData = z.infer<typeof errorDataSchema>;

/** The `error` object itself. */
export const errorEnvelopeSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.array(errorDetailSchema).optional(),
  data: errorDataSchema.optional(),
  /** Echoed by the server and logged (plan §9.1), so a support ticket can find the request. */
  requestId: z.string().min(1).optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** A whole error response body — what every non-2xx carries, `404` on an unknown route included. */
export const errorResponseSchema = z.object({ error: errorEnvelopeSchema });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Builds a body from a code, filling in the default message. `data` is only ever passed for the two
 * codes that carry it (§9.1); every other code omits the key rather than sending `null`.
 */
export function errorResponseBody(input: {
  readonly code: ApiErrorCode;
  readonly message?: string;
  readonly details?: readonly ErrorDetail[];
  readonly data?: ErrorData;
  readonly requestId?: string;
}): ErrorResponse {
  const envelope: ErrorEnvelope = {
    code: input.code,
    message: input.message ?? API_ERROR_MESSAGES[input.code],
  };
  // Omit-not-null: a client that reads `data` must be able to trust that a missing key means the
  // code carries no payload, rather than testing for `null` as well.
  if (input.details !== undefined) envelope.details = [...input.details];
  if (input.data !== undefined) envelope.data = input.data;
  if (input.requestId !== undefined) envelope.requestId = input.requestId;
  return { error: envelope };
}

/** Narrows `data` for the duplicate-create case (PR-09 emits it, PR-12 consumes it). */
export function isConflictErrorData(data: unknown): data is ConflictErrorData {
  return conflictErrorDataSchema.safeParse(data).success;
}

/** Narrows `data` for the version-conflict case (PR-10 emits it, PR-14 consumes it). */
export function isVersionConflictErrorData(data: unknown): data is VersionConflictErrorData {
  return versionConflictErrorDataSchema.safeParse(data).success;
}

/** The status a code answers with, for callers that only have the code. */
export function errorStatus(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}

/**
 * The reverse look-up, for the two places that only ever have a status: the server's handler (Fastify
 * picked a status, a code must be reported) and `apps/web/src/lib/api.ts` (a proxy or a gateway
 * answered something that is not an envelope at all).
 *
 * Defined only where the answer is unambiguous. `409` means `CONFLICT`, never `VERSION_CONFLICT`,
 * because a status cannot tell the two apart and the plain one is the honest default; `500` is absent
 * on purpose, so a caller decides for itself whether it means `INTERNAL` or a retry.
 */
const STATUS_TO_CODE: ReadonlyMap<number, ApiErrorCode> = new Map<number, ApiErrorCode>([
  [400, 'VALIDATION'],
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [429, 'RATE_LIMITED'],
]);

export function apiErrorCodeForStatus(status: number): ApiErrorCode | undefined {
  return STATUS_TO_CODE.get(status);
}

/**
 * `GET /api/health` and `GET /api/healthz` (plan §9.2 #1).
 *
 * PR-04 wired the probe, so there are exactly two answers and both are described here: a `200` answers
 * `{status:'ok', db:'ok', version}`, and the `503` a probe that failed to answer sends
 * `{status:'error', db:'error', version}`. They are paired rather than independent fields, because a route
 * that reports the database as broken while claiming to be healthy is a bug, not a state — which is also why
 * `{status:'ok', db:'error'}` stays rejected.
 */
export const healthResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), db: z.literal('ok'), version: z.string().min(1) }),
  z.object({ status: z.literal('error'), db: z.literal('error'), version: z.string().min(1) }),
]);
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * An ISO-8601 UTC timestamp string, i.e. what `JSON.stringify(new Date())` produces. Every timestamp
 * in a response body is one of these; nothing in the API serialises a `Date` any other way.
 */
export const isoDateTimeSchema = z.iso.datetime();

/** The page/limit pair a paginated list accepts, as query strings (`z.coerce` because queries are strings). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Wraps an item schema in the one envelope the MVP uses for every list: the page itself plus the
 * total, so a client can render "of 128" without a second round-trip. `paginatedSchema(noteSchema)`
 * is how a later list endpoint states its response; the tree and search endpoints keep their own
 * shapes because their responses are not pages (§9.2 #12 and #21).
 */
export function paginatedSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
}
export type Paginated<Item extends z.ZodType> = z.infer<ReturnType<typeof paginatedSchema<Item>>>;

/** The double-submit cookie (`note_csrf`) the SPA echoes back (§10); deliberately not `HttpOnly`. */
export const CSRF_COOKIE_NAME = 'note_csrf';

/** The header `apps/web/src/lib/api.ts` sets on every mutation. */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** The `HttpOnly` session cookie (PR-07). Named here so the SPA can describe it in a UI without a magic string. */
export const SESSION_COOKIE_NAME = 'note_session';

/** `Max-Age` of `note_csrf`, in seconds: one day, shorter than the session it guards (§10). */
export const CSRF_COOKIE_MAX_AGE_SECONDS = 86_400;

/** Methods that change state, i.e. the ones that need `X-CSRF-Token` (§9.3). */
export const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type MutationMethod = (typeof MUTATION_METHODS)[number];

/** Case-insensitive, because `fetch` accepts a lower-case `method` and `Headers` would echo it back. */
export function isMutationMethod(method: string): boolean {
  return (MUTATION_METHODS as readonly string[]).includes(method.toUpperCase());
}
