/**
 * Every mapping case of the error handler, both directly (`mapError`) and through a real request
 * (`buildApp()` + `app.inject()`), as docs/plans/mvp/MVP-05.md §11 requires.
 */
import { errorResponseSchema, isVersionConflictErrorData, renameMoveSchema } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { EnvelopeError } from '../crypto/envelope.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  VersionConflictError,
} from '../domain/errors.js';
import { parseEnv } from '../env.js';
import { createTestLogger } from '../logger.js';

// `registerErrorHandlers()` is exercised through `buildApp()` below, which is how a route PR gets it.
import { mapError } from './error-handler.js';

/** A driver error the way `drizzle-orm` reports one: its own wrapper, whose `cause` carries the code. */
function driverError(code: string): unknown {
  const wrapped = Object.assign(new Error(`insert into "notes" violated ${code}`), { code, table: 'notes' });
  return Object.assign(new Error('failed to execute query'), { cause: wrapped });
}

describe('mapError: domain errors', () => {
  it('answers NOT_FOUND with the entity it was given, and no data', () => {
    const mapped = mapError(new NotFoundError('note'));
    expect(mapped).toEqual({ status: 404, code: 'NOT_FOUND', message: 'note not found' });
    // The same answer whether the row is missing or belongs to someone else (§9.1: no id probing).
    expect(mapError(new NotFoundError('folder'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'folder not found',
    });
  });

  it('carries the winner of a duplicate create as data.id (§9.1)', () => {
    const mapped = mapError(
      new ConflictError('name already exists in this folder', {
        existingId: '0f6f0c1a-0000-4000-8000-000000000000',
        details: [{ path: 'name', message: 'must be unique among siblings' }],
      }),
    );
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('CONFLICT');
    expect(mapped.data).toEqual({ id: '0f6f0c1a-0000-4000-8000-000000000000' });
    expect(mapped.details).toEqual([{ path: 'name', message: 'must be unique among siblings' }]);
    // A clash without a winner to adopt (a non-empty folder, an existing owner) omits `data` entirely.
    expect(mapError(new ConflictError('folder is not empty')).data).toBeUndefined();
  });

  it('carries the current server content and version for VERSION_CONFLICT, which PR-14 reads', () => {
    const mapped = mapError(new VersionConflictError('the text on the server', 7));
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('VERSION_CONFLICT');
    // Same status as CONFLICT, different code: the discriminator is the code, never the status.
    expect(mapped.code).not.toBe(mapError(new ConflictError('x')).code);
    if (mapped.data === undefined) throw new Error('a version conflict without data is a contract break');
    expect(isVersionConflictErrorData(mapped.data)).toBe(true);
    expect(mapped.data).toEqual({ content: 'the text on the server', version: 7 });
  });

  it('maps the rest of the set to the status the contract gives the code', () => {
    // 401 is the code the SPA's `onUnauthorized` hook branches on, so it is a domain answer too.
    expect(mapError(new UnauthorizedError())).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(mapError(new ForbiddenError('only the owner may create accounts'))).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(mapError(new PayloadTooLargeError(1048576))).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(mapError(new RateLimitedError())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});

describe('mapError: validation failures', () => {
  it('turns Zod issues into {path, message} details on a 400', () => {
    const result = renameMoveSchema.safeParse({ name: 'work/2026' });
    if (result.success) throw new Error('the fixture must be invalid for this test to mean anything');

    const mapped = mapError(result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('VALIDATION');
    expect(mapped.details).toEqual([{ path: 'name', message: expect.any(String) }]);
  });

  it('reports a body-level issue under `body`, because the envelope has no empty path', () => {
    const result = renameMoveSchema.safeParse({});
    if (result.success) throw new Error('an empty PATCH must be invalid for this test to mean anything');
    expect(mapError(result.error).details).toEqual([{ path: 'body', message: expect.any(String) }]);
  });

  it('still reads a ZodError from a second copy of the library as a validation failure', () => {
    // `instanceof` is the fast path; a second `zod` install in the graph (a plugin with its own) would
    // otherwise turn every bad request into a 500.
    const foreign = { name: 'ZodError', issues: [{ path: ['content'], message: 'too big' }] };
    expect(mapError(foreign)).toMatchObject({
      status: 400,
      code: 'VALIDATION',
      details: [{ path: 'content', message: 'too big' }],
    });
    // An issue with no message text still yields a detail the client can render.
    expect(mapError({ name: 'ZodError', issues: [{ path: [] }] }).details).toEqual([
      { path: 'body', message: 'is not valid' },
    ]);
    // And a list with nothing in it omits `details` rather than sending an empty array.
    expect(mapError({ name: 'ZodError', issues: [] }).details).toBeUndefined();
  });
});

describe('mapError: the Postgres codes that mean a retry may work', () => {
  it('answers 409 CONFLICT for 40001, 40P01 and 23505, whatever wraps them', () => {
    for (const code of ['40001', '40P01', '23505']) {
      const mapped = mapError(driverError(code));
      expect(mapped.status, code).toBe(409);
      expect(mapped.code, code).toBe('CONFLICT');
      // The driver's text can name a table, a column or the statement — it stays in the log.
      expect(mapped.message).not.toContain('notes');
      expect(mapped.message).not.toContain(code);
    }
  });

  it('finds the code on the error itself, not only on its cause', () => {
    expect(mapError(Object.assign(new Error('serialization failure'), { code: '40001' })).code).toBe(
      'CONFLICT',
    );
    expect(mapError({ sqlstate: '40P01', message: 'deadlock' }).code).toBe('CONFLICT');
    expect(mapError({ errno: '23505' }).code).toBe('CONFLICT');
  });

  it('does not treat every error with a code as a conflict', () => {
    // A Fastify error code, and a code the handler deliberately does not know, both fall through.
    expect(mapError({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode: 400 }).code).toBe('VALIDATION');
    expect(mapError(driverError('22P02')).code).toBe('INTERNAL');
    // …and the walk stops rather than looping on a cyclic chain.
    const cyclic: { cause: unknown } = { cause: null };
    cyclic.cause = cyclic;
    expect(mapError(cyclic).code).toBe('INTERNAL');
  });
});

describe('mapError: the mappings PR-09 added', () => {
  it('answers a foreign-key violation with 404, because the parent the request named is gone', () => {
    // The service scopes every body `folderId`/`parentId` first, so this is the race: the folder was deleted
    // between the check and the insert. A 500 would be a lie about who broke, and a 409 would advise a retry that
    // can never work (docs/plans/mvp/MVP-09.md §5.4).
    const mapped = mapError(driverError('23503'));
    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe('NOT_FOUND');
    // The code's own default sentence, not the driver's: what must never reach a client is the text that names the
    // constraint or the two rows involved.
    expect(mapped.message).toBe('not found');
    expect(JSON.stringify(mapped)).not.toContain('23503');
    // …and it is the same answer a missing row gives, so the race is not an existence oracle.
    expect(mapped.status).toBe(mapError(new NotFoundError('folder')).status);
  });

  it('answers an envelope failure with 500 and the note id in the log, never an empty body', () => {
    const id = '0f6f0c1a-0000-4000-8000-000000000000';
    const mapped = mapError(
      new EnvelopeError(
        'note content failed to authenticate (bad AAD, a truncated tag, or the wrong key version)',
        {
          noteId: id,
        },
      ),
    );
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL');
    // The generic text: `EnvelopeError`'s own names key versions and fingerprints, and the client cannot act on
    // either. What it must not get is `content: ""`, which would read as an empty note (MVP-09 §7).
    expect(mapped.message).toBe('internal error');
    // The operator's half: which row.
    expect(mapped.logContext).toEqual({ noteId: id });
    // An envelope failure about something other than a note has no id to name, and invents none.
    expect(
      mapError(new EnvelopeError('the sealed triple is not a parseable envelope')).logContext,
    ).toBeUndefined();
  });

  it('keeps the depth-cap refusal a field error that names the cap', () => {
    // §4 #13: `parentId` was otherwise a well-formed uuid, so the message is the only thing the client can show.
    const mapped = mapError(
      new ValidationError(
        'a folder there would sit at depth 100, and the tree is capped at 100 levels (depths 0-99)',
        {
          details: [{ path: 'parentId', message: 'may not nest a folder below depth 99' }],
        },
      ),
    );
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('VALIDATION');
    expect(mapped.message).toContain('capped at 100 levels');
    expect(mapped.details?.[0]?.path).toBe('parentId');
  });
});

describe('mapError: everything else', () => {
  it('keeps a 4xx Fastify chose, and replaces its developer-facing text', () => {
    expect(mapError(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 }))).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'too many attempts, try again later',
    });
    expect(mapError(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }))).toMatchObject({
      status: 415,
      code: 'VALIDATION',
    });
    expect(mapError(Object.assign(new Error('unauthorized'), { statusCode: 401 })).code).toBe('UNAUTHORIZED');
    expect(mapError(Object.assign(new Error('gone'), { statusCode: 404 })).code).toBe('NOT_FOUND');
    expect(mapError(Object.assign(new Error('conflict'), { statusCode: 409 })).code).toBe('CONFLICT');
  });

  it('never repeats a 400 that quotes the request back', () => {
    // What `JSON.parse` throws for a body that contains someone's note.
    const syntaxError = Object.assign(
      new SyntaxError('Unexpected token in JSON at position 2: "my secret note"'),
      {
        statusCode: 400,
      },
    );
    const mapped = mapError(syntaxError);
    expect(mapped).toEqual({ status: 400, code: 'VALIDATION', message: 'the request body is not valid' });
  });

  it('answers INTERNAL, and nothing else, for anything unmapped', () => {
    for (const error of [
      new Error('db exploded'),
      undefined,
      null,
      'a string thrown',
      1n,
      new SyntaxError('?'),
    ]) {
      expect(mapError(error)).toEqual({ status: 500, code: 'INTERNAL', message: 'internal error' });
    }
    // A 5xx is the server's own fault, so its status does not earn the client a more precise code.
    expect(mapError(Object.assign(new Error('upstream said no'), { statusCode: 502 })).code).toBe('INTERNAL');
  });

  it('refuses to let a look-alike error pick its own status', () => {
    // Duck-typed domain errors are how an attacker-controlled object would get a 4xx of its choosing.
    const impostor = { code: 'NOT_FOUND', status: 404, message: 'trust me' };
    expect(mapError(impostor).code).toBe('INTERNAL');
  });
});

describe('registerErrorHandlers through buildApp()', () => {
  /** One app, several stub routes, so the handler is exercised the way a route PR will use it. */
  async function makeApp() {
    const app = await buildApp({ env: parseEnv({ NODE_ENV: 'test' }), logger: createTestLogger() });
    app.get('/api/stub/not-found', () => {
      throw new NotFoundError('note');
    });
    app.get('/api/stub/version-conflict', () => {
      throw new VersionConflictError('server text', 7);
    });
    app.get('/api/stub/serialization', () => {
      throw driverError('40001');
    });
    app.get('/api/stub/rate-limited', () => {
      throw new RateLimitedError('too many attempts, try again later', { retryAfterSeconds: 90 });
    });
    app.get('/api/stub/rate-limited-without-a-number', () => {
      throw new RateLimitedError();
    });
    // PR-09's two: a parent row that vanished mid-write, and a note body that will not authenticate.
    app.get('/api/stub/foreign-key', () => {
      throw driverError('23503');
    });
    app.get('/api/stub/envelope', () => {
      throw new EnvelopeError('note content failed to authenticate (bad AAD, or the wrong key version)', {
        noteId: '0f6f0c1a-0000-4000-8000-000000000000',
      });
    });
    app.post('/api/stub/echo', () => ({ received: true }));
    await app.ready();
    return app;
  }

  it('sends Retry-After when the domain error carried a number of seconds (§10)', async () => {
    const app = await makeApp();
    const limited = await app.inject('/api/stub/rate-limited');

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('90');
    expect(errorResponseSchema.safeParse(limited.json()).success).toBe(true);
    // The seconds are a header and not a body field: plan §9.1's envelope has nine codes and no retry shape, so
    // inventing one here would be a change to the contract that only this endpoint obeyed.
    expect(limited.body).not.toMatch(/retry/i);

    // The other half: a 429 with no number of seconds to give writes no header, rather than a `Retry-After:
    // undefined` that a client would parse as a wait of NaN seconds.
    const unnumbered = await app.inject('/api/stub/rate-limited-without-a-number');
    expect(unnumbered.statusCode).toBe(429);
    expect(unnumbered.headers['retry-after']).toBeUndefined();
    await app.close();
  });

  it('answers a domain error with its code, its status and the same envelope', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/stub/not-found');

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'note not found' } });
    await app.close();
  });

  it('sends the version-conflict payload to the client that needs it', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/stub/version-conflict');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT', data: { content: 'server text', version: 7 } },
    });
    await app.close();
  });

  it('turns a serialization failure into a retryable 409 rather than an unexplained 500', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/stub/serialization');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(response.body).not.toContain('insert into');
    await app.close();
  });

  it('carries a request id in both the body and the header, so a log line can be found from either', async () => {
    const app = await makeApp();
    const missing = await app.inject('/api/nothing-here');
    // `content-type` spelled out: `inject` does not guess it, and without it Fastify answers 415
    // before the JSON parser ever sees the body.
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/stub/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"content": my secret note }',
    });

    for (const response of [missing, rejected]) {
      const body = response.json() as { error: { requestId: string } };
      expect(typeof body.error.requestId).toBe('string');
      expect(response.headers['x-request-id']).toBe(body.error.requestId);
      expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    }
    // A malformed JSON body is a bad request, and never an echo of what was sent.
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(rejected.body).not.toContain('my secret note');

    await app.close();
  });

  it('answers a vanished parent with 404 and a failed decryption with 500, in the same envelope', async () => {
    const app = await makeApp();

    // §5.4's net: the folder a note was being moved into stopped existing. The client is told the thing it named is
    // not there, and never that a constraint fired.
    const foreignKey = await app.inject('/api/stub/foreign-key');
    expect(foreignKey.statusCode).toBe(404);
    expect(errorResponseSchema.safeParse(foreignKey.json()).success).toBe(true);
    expect(foreignKey.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(foreignKey.body).not.toContain('23503');

    // §7's other half: the body cannot be served, so nothing is served. An empty `content` would be a note the
    // user could overwrite and lose the only copy.
    const envelope = await app.inject('/api/stub/envelope');
    expect(envelope.statusCode).toBe(500);
    expect(errorResponseSchema.safeParse(envelope.json()).success).toBe(true);
    expect(envelope.json()).toMatchObject({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(envelope.body).not.toContain('AAD');
    expect(envelope.body).not.toContain('0f6f0c1a');

    await app.close();
  });
});
