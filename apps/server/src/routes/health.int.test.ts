/**
 * `/api/health` with the database wired (docs/plans/mvp/MVP-04.md §6).
 *
 * PR-01 shipped the endpoint with `db` hardcoded to `'ok'`; this file is what changed: the payload now reports
 * the database, and it reports it as a *status*, never as a reason. A failure that quotes the DSN (a bad
 * password, a refused connection, the wrong host) must stay in the log, because `/api/health` is unauthenticated
 * and PR-18's `HEALTHCHECK` polls it from outside the container.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle, probeDb } from '../db/client.js';
import { databaseUrl } from '../env.js';
import { withApp } from '../test/helpers/app.js';
import { testDb } from '../test/helpers/db.js';

/** The pool `/api/health` probes is the suite's shared one; this second pool proves the failure path. */
let dead: DbHandle | undefined;

beforeAll(async () => {
  // A pool of its own, closed mid-test: `probeDb()` on a closed pool is the closest honest stand-in for a
  // database that has stopped answering, without stopping the one the suite shares.
  dead = createDb({ url: databaseUrl(), max: 1 });
  await probeDb(dead.db);
  await dead.close();
});

afterAll(async () => {
  await dead?.close();
});

describe('GET /api/health (PR-04: db is wired)', () => {
  it('answers 200 and reports the database through the real probe', async () => {
    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/api/health' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toStrictEqual({
          status: 'ok',
          db: 'ok',
          version: expect.any(String),
        });
      },
      { checkDb: () => probeDb(testDb()) },
    );
  });

  it('answers 200 on /api/healthz too, the path PR-18 will poll', async () => {
    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/api/healthz' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'ok', db: 'ok' });
      },
      { checkDb: () => probeDb(testDb()) },
    );
  });

  it('takes its version from this package rather than the placeholder', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/api/health' });
        expect(response.json()).toMatchObject({ version: manifest.version });
      },
      { checkDb: () => probeDb(testDb()) },
    );
  });

  it('answers 503 with db:error when the database does not answer, and says nothing about why', async () => {
    const pool = dead;
    if (!pool) throw new Error('beforeAll did not open the closed pool');

    await withApp(
      async (app) => {
        const response = await app.inject({ method: 'GET', url: '/api/health' });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toStrictEqual({
          status: 'error',
          db: 'error',
          version: expect.any(String),
        });
        // The DSN, the driver's error text and any hint of the host must not appear in the body.
        expect(response.body).not.toMatch(/postgres:\/\//);
        expect(response.body).not.toMatch(/localhost/);
        expect(response.body).not.toMatch(/closed|refused|ECONNREFUSED/i);
      },
      { checkDb: () => probeDb(pool.db) },
    );
  });

  it('still reports ok when no probe is wired at all (the pool-less boot and PR-01 unit tests)', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', db: 'ok' });
    });
  });
});
