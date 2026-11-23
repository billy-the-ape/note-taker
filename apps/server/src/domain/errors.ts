/**
 * The typed domain errors (docs/plans/mvp/MVP-05.md §5).
 *
 * A service throws one of these; `plugins/error-handler.ts` is the only place that turns it into an
 * HTTP answer. That is why each error carries an `ApiErrorCode` from `@note-taker/contracts` rather
 * than a status number: the status comes from the shared code→status table, so a domain error and
 * the transport it produces cannot drift apart, and a code that does not exist in the contract is a
 * type error here rather than a surprise on the wire.
 *
 * Rules these types exist to keep (§9.1, §9.2):
 *
 * * Cross-user access is `NotFoundError`, never `ForbiddenError` — a `403` on somebody else's id
 *   confirms the id exists.
 * * A sibling-name clash is `ConflictError`, never a validation failure, and a duplicate create
 *   carries the id of the row that won so the caller can adopt it.
 * * A stale content write is `VersionConflictError`, and it carries the **current server plaintext
 *   and version** — the pair PR-14's autosave engine compares against the snapshot it put on the
 *   wire, so the client never has to re-fetch a note it just failed to save.
 */
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ErrorData,
  type ErrorDetail,
  type VersionConflictErrorData,
} from '@note-taker/contracts';

/** What a service may hand to `throw`. `cause` keeps the original failure for the log, never the client. */
export interface DomainErrorOptions {
  /** Code-specific payload for the envelope's `data` (§9.1); most errors have none. */
  readonly data?: ErrorData;
  /** Field errors for the envelope's `details`. */
  readonly details?: readonly ErrorDetail[];
  /**
   * Whole seconds the caller should wait before retrying, rendered as the `Retry-After` header
   * (plan §10's `429 RATE_LIMITED` from PR-07's login window). Optional on the base rather than a field of
   * `RateLimitedError` alone, because "when may I ask again" is a property of the answer, not of one class:
   * a later PR that throttles search or writes gets the header by passing the same option.
   */
  readonly retryAfterSeconds?: number;
  /** Wrapped failure, for `Error#cause` and the server log only. */
  readonly cause?: unknown;
}

/**
 * Base class: `code` is the contract's discriminator and `status` is derived from it, so the two can
 * never be reported inconsistently.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ApiErrorCode;
  /**
   * Code-specific payload, i.e. the envelope's `data`. Only `ConflictError` and
   * `VersionConflictError` define it (§9.1); every other error leaves the key out.
   */
  readonly data?: ErrorData;
  readonly details?: readonly ErrorDetail[];
  /** The `Retry-After` value this error asks for, when it asks for one. See {@link DomainErrorOptions}. */
  readonly retryAfterSeconds?: number;

  protected constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    // Assigned here rather than in each subclass, because `readonly` fields belong to the constructor
    // that declares them — and because it keeps `data`/`details` optional without `| undefined` in the
    // type, which is what lets the envelope leave the keys out instead of sending nulls.
    if (options.data !== undefined) this.data = options.data;
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** The status this error answers with, straight from the shared table. */
  get status(): number {
    return API_ERROR_STATUS[this.code];
  }
}

/**
 * `VALIDATION` (400) for a request the server cannot honour even though its body parsed.
 *
 * `ZodError` covers "this field is not a string/uuid/too long", and that is most of what `VALIDATION` means.
 * This is the rest: a rule the *server* has to check against the current state of the database, where a field
 * error is still the true report. The 100-level folder cap of §9.2 #13/#14 is the case that needed it —
 * `parentId: "<the deepest folder>"` is a perfectly well-formed uuid, and answering `CONFLICT` would tell the
 * caller to retry something that will never succeed, while `NOT_FOUND`/`FORBIDDEN` would describe a folder the
 * request never asked about. `details` carries the field the caller has to change, exactly like a schema
 * failure, so the SPA renders it with the same form code.
 */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION' as const;

  constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, options);
  }
}

/** `NOT_FOUND` (404). Also the answer to "that row exists, but is not yours" (§9.1). */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND' as const;

  /**
   * @param entity What was looked for (`note`, `folder`, `user`, …), so the log says something useful
   *   while the client still gets the same undifferentiated `NOT_FOUND` either way.
   */
  constructor(
    readonly entity: string,
    options: DomainErrorOptions = {},
  ) {
    super(`${entity} not found`, options);
  }
}

/**
 * `UNAUTHORIZED` (401): the caller is not who the request claimed to be — an expired or revoked
 * session. Distinct from `ForbiddenError`, which is "we know you, and no": the SPA branches on this
 * one code by routing to the sign-in screen (`lib/api.ts`'s `onUnauthorized` hook).
 */
export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED' as const;

  constructor(message = 'you are not signed in', options: DomainErrorOptions = {}) {
    super(message, options);
  }
}

/** `FORBIDDEN` (403), i.e. a caller who is who they say they are and still may not do this. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN' as const;

  constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * `CONFLICT` (409): the write does not apply to the current state — a sibling already has the name,
 * a folder is not empty without `cascade=true`, an owner already exists.
 */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT' as const;

  /**
   * @param existingId The id of the row that already exists, for the duplicate-create case: `data.id`
   *   lets a double-clicked "Create" adopt the winner instead of firing twice (§9.1).
   */
  constructor(
    message: string,
    { existingId, ...options }: DomainErrorOptions & { readonly existingId?: string } = {},
  ) {
    // The field name is pinned by `conflictErrorDataSchema`; a typo here would be a silent contract break.
    super(message, existingId === undefined ? options : { ...options, data: { id: existingId } });
  }
}

/** `VERSION_CONFLICT` (409), carrying the current server state for PR-14's conflict UI. */
export class VersionConflictError extends DomainError {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly content: string,
    readonly version: number,
    options: DomainErrorOptions = {},
  ) {
    // The exact pair PR-14 compares against the snapshot it put on the wire, in the shape
    // `versionConflictErrorDataSchema` pins.
    const data: VersionConflictErrorData = { content, version };
    super('someone saved this note first', { ...options, data });
  }
}

/**
 * `PAYLOAD_TOO_LARGE` (413): the note body is past `MAX_NOTE_BYTES`. The transport refuses an
 * over-cap body before this is ever reached; a service throws it when the *decoded* plaintext is over
 * the cap of its own accord (§7's note-size rules).
 */
export class PayloadTooLargeError extends DomainError {
  readonly code = 'PAYLOAD_TOO_LARGE' as const;

  constructor(
    readonly maxBytes: number,
    options: DomainErrorOptions = {},
  ) {
    super(`a note may be at most ${maxBytes} bytes`, options);
  }
}

/** `RATE_LIMITED` (429), e.g. the login attempts a `LOGIN_RATE_LIMIT_MAX` window allows (PR-07). */
export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED' as const;

  constructor(message = 'too many attempts, try again later', options: DomainErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Narrows anything thrown by a hook, plugin or service. `instanceof` rather than a duck-typed check,
 * so an unrelated error that happens to carry a `code` property cannot impersonate a domain failure
 * and pick its own HTTP status.
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
