/**
 * Zod / domain / database failure → the one error envelope (docs/plans/mvp/MVP-05.md §5–§6),
 * registered inside `buildApp()` so it covers every route, including the ones that do not exist yet.
 *
 * `mapError()` is deliberately **pure**: it turns `unknown` into a `{status, code, message, …}`
 * triple and knows nothing about Fastify, which is what makes every mapping case unit-testable
 * without a server. `registerErrorHandlers()` is the thin shell that answers with it.
 *
 * Three properties this file is responsible for:
 *
 * * **Nothing invents a code.** The code comes from `@note-taker/contracts`, and the status comes
 *   from the code, so a handler cannot report `CONFLICT` with a `400`.
 * * **A `5xx` never repeats what it was told.** The message for anything unmapped is the code's
 *   default. A driver error, a `SyntaxError` from a JSON parser, or a service's own exception text
 *   may contain a DSN, a column name, or a snippet of someone's note; all of it stays in the log.
 * * **A retryable failure says so.** Postgres `40001` (serialization failure) and `40P01` (deadlock)
 *   are the two cases where the *same* write may succeed if it is sent again, so they answer `409`
 *   `CONFLICT` rather than an unexplained `INTERNAL`; `23505` (unique violation) is the same class of
 *   "your write does not apply to the current state" and gets the same treatment when a repository
 *   lets it through instead of raising `ConflictError` with the winner's id.
 */
import {
  API_ERROR_MESSAGES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  apiErrorCodeForStatus,
  type ErrorData,
  type ErrorDetail,
  errorResponseBody,
} from '@note-taker/contracts';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { isDomainError } from '../domain/errors.js';

/** A failure already translated into transport terms, with a message that is always safe to send. */
export interface MappedError {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ErrorDetail[];
  readonly data?: ErrorData;
  /** Whole seconds to put in `Retry-After`; only a domain error can ask for it (PR-07's login window). */
  readonly retryAfterSeconds?: number;
}

/**
 * The Postgres `sqlstate`s that mean "conflict, and a retry may work" (§9.1). A repository throws
 * `ConflictError` for the cases it can name; this is the net under the ones it cannot.
 */
const RETRYABLE_POSTGRES_CODES: ReadonlySet<string> = new Set([
  '40001', // serialization failure: a concurrent transaction committed first
  '40P01', // deadlock detected
  '23505', // unique violation, i.e. a sibling took the name under us
]);

/** How far down the `cause` chain to look for a driver code (drizzle wraps, `postgres` wraps again). */
const MAX_CAUSE_DEPTH = 4;

interface MaybeCoded {
  readonly sqlstate?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly cause?: unknown;
}

/**
 * The Postgres status code carried by an error, if it carries one.
 *
 * Structural rather than `instanceof DrizzleError`: `drizzle-orm` is PR-04's dependency, this PR must
 * compile without it, and a driver code is a string on the error either way — a wrapper chain of
 * `Error`s whose `cause` is the driver error is as real as the driver error itself.
 */
function postgresCodeOf(error: unknown, depth = 0): string | undefined {
  if (depth >= MAX_CAUSE_DEPTH || error === null || typeof error !== 'object') return undefined;
  const coded = error as MaybeCoded;
  for (const value of [coded.sqlstate, coded.code, coded.errno]) {
    if (typeof value === 'string' && RETRYABLE_POSTGRES_CODES.has(value)) return value;
  }
  return postgresCodeOf(coded.cause, depth + 1);
}

/**
 * A validation failure, from either copy of Zod this process could load.
 *
 * `instanceof` alone would be a silent trap: if the validator and the handler ever resolve to
 * different `zod` installs, a `ZodError` from one fails `instanceof` in the other and every bad
 * request would answer `500` instead of `400`. The `name`/`issues` shape check is the fallback.
 */
function isValidationError(error: unknown): error is ZodError {
  if (error instanceof ZodError) return true;
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { readonly name?: unknown; readonly issues?: unknown };
  return candidate.name === 'ZodError' && Array.isArray(candidate.issues);
}

/** A body-level issue has no path; the envelope has no empty path either, so it reports as `body`. */
const ROOT_PATH = 'body';

function detailsFrom(issues: readonly unknown[]): ErrorDetail[] {
  return issues.map((issue) => {
    const candidate = issue as { readonly path?: unknown; readonly message?: unknown };
    const rawPath = Array.isArray(candidate.path) ? candidate.path : [];
    const path = rawPath.length > 0 ? rawPath.map(String).join('.') : ROOT_PATH;
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'is not valid';
    return { path, message };
  });
}

/**
 * The code for a status Fastify (or a plugin) already chose. The shared look-up covers the statuses
 * that have exactly one code; any other 4xx is a malformed or unusable request, which is
 * `VALIDATION` — the honest remaining member of the set (§9.1), since `INTERNAL` would be a lie about
 * who broke.
 */
function codeForStatus(status: number): ApiErrorCode {
  return apiErrorCodeForStatus(status) ?? 'VALIDATION';
}

/** Fastify puts `statusCode` on every error it raises itself (`FST_ERR_*`), 500 otherwise. */
function statusCodeOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : undefined;
}

/**
 * The one mapping table. Order matters: a domain error is a decision the app made, a validation error
 * is a decision the request made, a driver code is a decision the database made, and everything else
 * is the server's own fault.
 */
export function mapError(error: unknown): MappedError {
  if (isDomainError(error)) {
    // A domain error's own message is written for the user, and its `data` is the §9.1 payload.
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.data === undefined ? {} : { data: error.data }),
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }

  if (isValidationError(error)) {
    const details = detailsFrom(error.issues as readonly unknown[]);
    return {
      status: API_ERROR_STATUS.VALIDATION,
      code: 'VALIDATION',
      message: API_ERROR_MESSAGES.VALIDATION,
      ...(details.length === 0 ? {} : { details }),
    };
  }

  const postgresCode = postgresCodeOf(error);
  if (postgresCode !== undefined) {
    // Never the driver's text: it can name a table, a column, or the statement that failed.
    return {
      status: API_ERROR_STATUS.CONFLICT,
      code: 'CONFLICT',
      message: 'that conflicts with the current state, try again',
    };
  }

  const status = statusCodeOf(error);
  if (status !== undefined && status < 500) {
    // Fastify's own 4xx messages are written for developers and a `SyntaxError` from the JSON parser
    // can quote the body back, so a 4xx keeps its status and gets a message from the code instead.
    const code = codeForStatus(status);
    return { status, code, message: API_ERROR_MESSAGES[code] };
  }

  return { status: API_ERROR_STATUS.INTERNAL, code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL };
}

/** Fastify's request id, as the string the envelope and the `x-request-id` header both carry. */
function requestIdOf(request: FastifyRequest): string {
  return String(request.id);
}

/**
 * Installs the envelope on an app: `setErrorHandler` for anything a route throws, and
 * `setNotFoundHandler` so an unknown path answers the same contract instead of Fastify's HTML.
 *
 * Called by `buildApp()` (app-level, not inside a prefixed plugin) so one registration covers every
 * route the later PRs add. A route PR that needs an extra mapping case adds it to `mapError()`, not
 * to a route.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // `method`/`url` are the request's own words, which is what makes this message useful in a log;
    // it is serialised as JSON, so it cannot smuggle markup into a page.
    reply
      .status(API_ERROR_STATUS.NOT_FOUND)
      .header('x-request-id', requestIdOf(request))
      .send(
        errorResponseBody({
          code: 'NOT_FOUND',
          message: `no route for ${request.method} ${request.url}`,
          requestId: requestIdOf(request),
        }),
      );
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(error);
    const requestId = requestIdOf(request);

    if (mapped.status >= 500) {
      // The only place the real failure is recorded; the client gets `internal error` and this id.
      request.log.error({ err: error, code: mapped.code, requestId }, 'request failed');
    } else {
      request.log.debug({ err: error, code: mapped.code, requestId }, 'request rejected');
    }

    // Split out of the chain because one header here is optional, and a conditional in the middle of a
    // fluent call is how people end up sending `undefined` as a string.
    const response = reply.status(mapped.status).header('x-request-id', requestId);
    if (mapped.retryAfterSeconds !== undefined) {
      // Plan §10: the `429` from the login window says when to come back. Seconds rather than an HTTP-date,
      // because the value comes from a sliding window this process owns and a date would be a guess about
      // the client's clock.
      response.header('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.send(
      errorResponseBody({
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
        ...(mapped.data === undefined ? {} : { data: mapped.data }),
        requestId,
      }),
    );
  });
}
