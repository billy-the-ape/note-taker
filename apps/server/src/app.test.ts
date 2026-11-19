import { errorResponseSchema, healthResponseSchema } from '@note-taker/contracts';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { parseEnv } from './env.js';
import { createTestLogger } from './logger.js';

/**
 * `buildApp()` takes its dependencies, so the API is exercised through `app.inject()` and never
 * binds a port — the same harness every `*.int.test.ts` file PR-04 adds will use.
 */
async function makeApp() {
  const app = await buildApp({ env: parseEnv({ NODE_ENV: 'test' }), logger: createTestLogger() });
  await app.ready();
  return app;
}

describe('GET /api/health', () => {
  it('returns 200 with the ok payload', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/health');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      status: 'ok',
      db: 'ok',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    // The contract, not just the shape PR-01 hand-wrote: this is the body the client's schema accepts.
    expect(() => healthResponseSchema.parse(response.json())).not.toThrow();

    await app.close();
  });

  it('answers HEAD like a well-behaved probe target', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'HEAD', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /api/healthz', () => {
  it('is the same payload, so the PR-18 HEALTHCHECK has a stable path', async () => {
    const app = await makeApp();
    const health = await app.inject('/api/health');
    const healthz = await app.inject('/api/healthz');

    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual(health.json());

    await app.close();
  });
});

describe('the §9.1 error envelope (PR-05 owns it; the route PRs only add mapping cases)', () => {
  it('answers an unknown route with the envelope, never the SPA or an HTML error page', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/nope');

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('rejects a body over MAX_NOTE_BYTES instead of buffering it', async () => {
    const app = await buildApp({
      env: parseEnv({ NODE_ENV: 'test', MAX_NOTE_BYTES: '1024' }),
      logger: createTestLogger(),
    });
    // A route added just for this test: the body cap is only observable on an endpoint that reads
    // a body, and PR-01 ships none. Registered before `ready()`, as Fastify requires.
    app.post('/api/size-probe', () => ({ received: true }));
    await app.ready();

    // application/json is the content type Fastify parses by default, which is the only path where
    // `bodyLimit` is reached (anything else is refused earlier with 415).
    const response = await app.inject({
      method: 'POST',
      url: '/api/size-probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'x'.repeat(2048) }),
    });
    expect(response.statusCode).toBe(413);
    // §7: an over-cap body is `PAYLOAD_TOO_LARGE`, not the generic `VALIDATION` a bad field gets.
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });

    await app.close();
  });

  it('turns an unhandled failure into a 500 that names nothing about the inside', async () => {
    const app = await buildApp({ env: parseEnv({ NODE_ENV: 'test' }), logger: createTestLogger() });
    app.get('/api/boom', () => {
      throw new Error('kaboom: postgres://user:password@localhost:5432/db');
    });
    await app.ready();

    const response = await app.inject('/api/boom');
    expect(response.statusCode).toBe(500);
    // `requestId` joins the body, so match on the envelope rather than the whole object.
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(errorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(typeof (response.json() as { error: { requestId?: unknown } }).error.requestId).toBe('string');
    expect(response.headers['x-request-id']).toBe(
      (response.json() as { error: { requestId: string } }).error.requestId,
    );
    expect(response.body).not.toContain('kaboom');
    expect(response.body).not.toContain('password');

    await app.close();
  });
});

describe('buildApp() dependency injection', () => {
  it('reports the version it was given, which is how a test pins what a container ships', async () => {
    const app = await buildApp({
      env: parseEnv({ NODE_ENV: 'test' }),
      logger: createTestLogger(),
      version: '9.9.9-test',
    });
    await app.ready();

    const response = await app.inject('/api/health');
    expect((response.json() as { version: string }).version).toBe('9.9.9-test');

    await app.close();
  });
});
