import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  API_ERROR_CODES,
  API_ERROR_MESSAGES,
  API_ERROR_STATUS,
  apiErrorCodeForStatus,
  apiErrorCodeSchema,
  CSRF_COOKIE_MAX_AGE_SECONDS,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  conflictErrorDataSchema,
  DEFAULT_PAGE_SIZE,
  errorDataSchema,
  errorDetailSchema,
  errorResponseBody,
  errorResponseSchema,
  errorStatus,
  healthResponseSchema,
  isConflictErrorData,
  isMutationMethod,
  isoDateTimeSchema,
  isVersionConflictErrorData,
  MAX_PAGE_SIZE,
  MUTATION_METHODS,
  paginatedSchema,
  paginationQuerySchema,
  SESSION_COOKIE_NAME,
  versionConflictErrorDataSchema,
} from './api-envelope.js';

describe('the code set of plan §9.1', () => {
  it('is exactly the nine documented codes', () => {
    expect(API_ERROR_CODES).toEqual([
      'VALIDATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'VERSION_CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'INTERNAL',
    ]);
    expect(apiErrorCodeSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
    expect(apiErrorCodeSchema.safeParse('VALIDATION').success).toBe(true);
  });

  it('maps every code to one status, with VERSION_CONFLICT sharing 409 with CONFLICT', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThan(399);
      expect(errorStatus(code)).toBe(API_ERROR_STATUS[code]);
      // A default message exists for every code, so an envelope never says nothing.
      expect(API_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    expect(API_ERROR_STATUS.VALIDATION).toBe(400);
    expect(API_ERROR_STATUS.UNAUTHORIZED).toBe(401);
    expect(API_ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(API_ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(API_ERROR_STATUS.CONFLICT).toBe(409);
    expect(API_ERROR_STATUS.VERSION_CONFLICT).toBe(409);
    expect(API_ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(API_ERROR_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    expect(API_ERROR_STATUS.INTERNAL).toBe(500);
    // The status is not the discriminator: `code` is, and these two need different handling.
    expect(API_ERROR_STATUS.CONFLICT).toBe(API_ERROR_STATUS.VERSION_CONFLICT);
  });

  it('reads a code back off the statuses that have exactly one', () => {
    expect(apiErrorCodeForStatus(400)).toBe('VALIDATION');
    expect(apiErrorCodeForStatus(401)).toBe('UNAUTHORIZED');
    expect(apiErrorCodeForStatus(403)).toBe('FORBIDDEN');
    expect(apiErrorCodeForStatus(404)).toBe('NOT_FOUND');
    // 409 answers `CONFLICT`: a status cannot tell a stale write from a name clash, and the client
    // must never infer `VERSION_CONFLICT` from a number it cannot trust.
    expect(apiErrorCodeForStatus(409)).toBe('CONFLICT');
    expect(apiErrorCodeForStatus(API_ERROR_STATUS.VERSION_CONFLICT)).toBe('CONFLICT');
    expect(apiErrorCodeForStatus(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(apiErrorCodeForStatus(429)).toBe('RATE_LIMITED');
    // 500 and every other status are deliberately unanswered, so the caller decides what they mean.
    expect(apiErrorCodeForStatus(500)).toBeUndefined();
    expect(apiErrorCodeForStatus(415)).toBeUndefined();
    expect(apiErrorCodeForStatus(200)).toBeUndefined();
  });

  it('names the methods that need a CSRF header', () => {
    expect(MUTATION_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(isMutationMethod('post')).toBe(true);
    expect(isMutationMethod('PATCH')).toBe(true);
    expect(isMutationMethod('GET')).toBe(false);
    expect(isMutationMethod('HEAD')).toBe(false);
  });

  it('pins the cookie and header names both ends must agree on', () => {
    expect(CSRF_COOKIE_NAME).toBe('note_csrf');
    expect(CSRF_HEADER_NAME).toBe('X-CSRF-Token');
    expect(SESSION_COOKIE_NAME).toBe('note_session');
    // One day: shorter than the session it guards, so a long-open tab re-issues it (§10).
    expect(CSRF_COOKIE_MAX_AGE_SECONDS).toBe(86_400);
  });
});

describe('errorResponseSchema', () => {
  it('accepts the documented example verbatim, data and details included', () => {
    const example = {
      error: {
        code: 'CONFLICT',
        message: 'name already exists in this folder',
        details: [{ path: 'name', message: 'must be unique among siblings' }],
        data: { id: '0f6f0c1a-0000-4000-8000-000000000000' },
        requestId: 'req-1',
      },
    };
    expect(errorResponseSchema.safeParse(example).success).toBe(true);
  });

  it('accepts the minimum body, because only `code` and `message` are always present', () => {
    expect(errorResponseSchema.safeParse({ error: { code: 'INTERNAL', message: 'boom' } }).success).toBe(
      true,
    );
  });

  it('rejects an unknown code, a non-string message, and a malformed detail item', () => {
    expect(errorResponseSchema.safeParse({ error: { code: 'TEAPOT', message: 'x' } }).success).toBe(false);
    expect(errorResponseSchema.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false);
    expect(
      errorResponseSchema.safeParse({
        error: { code: 'VALIDATION', message: 'x', details: [{ path: 'name' }] },
      }).success,
    ).toBe(false);
    expect(errorResponseSchema.safeParse({ code: 'INTERNAL', message: 'boom' }).success).toBe(false);
  });

  it('describes one field error as {path, message}', () => {
    expect(errorDetailSchema.safeParse({ path: 'folderId', message: 'must be a uuid' }).success).toBe(true);
    expect(errorDetailSchema.safeParse({ path: '', message: 'x' }).success).toBe(false);
  });
});

describe('errorResponseBody', () => {
  it('fills in the default message for a code', () => {
    expect(errorResponseBody({ code: 'NOT_FOUND' })).toEqual({
      error: { code: 'NOT_FOUND', message: API_ERROR_MESSAGES.NOT_FOUND },
    });
  });

  it('omits the optional keys instead of sending null, so a missing `data` means no payload', () => {
    const body = errorResponseBody({ code: 'INTERNAL', message: 'boom' });
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
    expect(body.error.data).toBeUndefined();
  });

  it('carries details, data and the request id when the caller has them', () => {
    const body = errorResponseBody({
      code: 'VERSION_CONFLICT',
      message: 'someone saved this note first',
      details: [{ path: 'baseVersion', message: 'is stale' }],
      data: { content: 'server text', version: 7 },
      requestId: 'req-7',
    });
    expect(errorResponseSchema.safeParse(body).success).toBe(true);
    expect(body.error.details).toEqual([{ path: 'baseVersion', message: 'is stale' }]);
    expect(isVersionConflictErrorData(body.error.data)).toBe(true);
    expect(body.error.requestId).toBe('req-7');
  });
});

describe('the two `data` shapes the plan pins (§9.1)', () => {
  it('narrows the duplicate-create payload and nothing else', () => {
    expect(isConflictErrorData({ id: '0f6f0c1a-0000-4000-8000-000000000000' })).toBe(true);
    expect(isConflictErrorData({ id: '' })).toBe(false);
    // Extra keys are refused: the field names of these two shapes are part of the contract.
    expect(isConflictErrorData({ id: 'x', existingId: 'x' })).toBe(false);
    expect(isConflictErrorData({})).toBe(false);
    expect(isConflictErrorData(undefined)).toBe(false);
    expect(conflictErrorDataSchema.safeParse({ id: 'x' }).success).toBe(true);
  });

  it('narrows the version-conflict payload: current server content plus version', () => {
    expect(isVersionConflictErrorData({ content: '', version: 1 })).toBe(true);
    expect(isVersionConflictErrorData({ content: 'text', version: 42 })).toBe(true);
    expect(isVersionConflictErrorData({ content: 'text' })).toBe(false);
    expect(isVersionConflictErrorData({ content: 'text', version: 1.5 })).toBe(false);
    expect(isVersionConflictErrorData({ content: 3, version: 1 })).toBe(false);
    expect(versionConflictErrorDataSchema.safeParse({ content: '', version: 0 }).success).toBe(true);
  });

  it('still accepts an arbitrary object on the wire, so a later code can add a variant', () => {
    expect(errorDataSchema.safeParse({ anything: 1, nested: { a: true } }).success).toBe(true);
    expect(errorDataSchema.safeParse('nope').success).toBe(false);
    // Unknown payloads are `data`, but they are never one of the two known shapes.
    const unknown = { note: 'value' };
    expect(errorDataSchema.safeParse(unknown).success).toBe(true);
    expect(isConflictErrorData(unknown)).toBe(false);
    expect(isVersionConflictErrorData(unknown)).toBe(false);
  });
});

describe('healthResponseSchema', () => {
  it('is {status:"ok", db:"ok", version} and nothing looser', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', db: 'ok', version: '0.1.0' }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: 'ok', db: 'error', version: '0.1.0' }).success).toBe(
      false,
    );
    expect(healthResponseSchema.safeParse({ status: 'ok', db: 'ok', version: '' }).success).toBe(false);
  });
});

describe('isoDateTimeSchema', () => {
  it('accepts what `JSON.stringify(new Date())` produces', () => {
    expect(isoDateTimeSchema.safeParse(new Date('2026-02-03T04:05:06.789Z').toISOString()).success).toBe(
      true,
    );
    expect(isoDateTimeSchema.safeParse('2026-02-03T04:05:06Z').success).toBe(true);
  });

  it('refuses a date, a local time, and free text', () => {
    expect(isoDateTimeSchema.safeParse('2026-02-03').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('2026-02-03T04:05:06.789').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('yesterday').success).toBe(false);
  });
});

describe('the list helpers', () => {
  it('defaults a page and coerces the query strings a browser actually sends', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(paginationQuerySchema.parse({ limit: '10', offset: '20' })).toEqual({ limit: 10, offset: 20 });
    expect(MAX_PAGE_SIZE).toBe(100);
  });

  it('refuses a page that cannot be served', () => {
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 'many' }).success).toBe(false);
  });

  it('wraps any item schema in {items, total, limit, offset}', () => {
    const schema = paginatedSchema(z.object({ id: z.string() }));
    const parsed = schema.safeParse({ items: [{ id: 'a' }], total: 1, limit: 50, offset: 0 });
    expect(parsed.success).toBe(true);
    expect(schema.safeParse({ items: [{ id: 'a' }], total: -1, limit: 50, offset: 0 }).success).toBe(false);
    expect(schema.safeParse({ items: [{ id: 'a' }], total: 1, limit: 0, offset: 0 }).success).toBe(false);
  });
});
