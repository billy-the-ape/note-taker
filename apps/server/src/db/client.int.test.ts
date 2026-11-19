/**
 * The process-wide pool (docs/plans/mvp/MVP-04.md §5): `getDb()` opens it on first use and hands the same handle
 * to every caller afterwards, and `closeDb()` releases it — twice, because shutdown and a test teardown both
 * reach for it and the second one must be a no-op rather than an error.
 *
 * These are the only tests that touch the application's own pool: everything else in the suite talks to the
 * dedicated pool in `src/test/helpers/db.ts`, so a test here must put the singleton back the way it found it.
 */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from './client.js';

afterEach(async () => {
  // The singleton is process-wide, so a test that closes it leaves it closed for the next one unless this runs.
  await closeDb();
});

describe('getDb() / closeDb()', () => {
  it('opens the pool once and hands the same handle back', async () => {
    const first = getDb();
    const second = getDb();

    expect(second).toBe(first);
    // Not merely an object identity: the pool answers, which is what `/api/health` and every repository need.
    const rows = await first.db.execute(sql`select 1 as one`);
    expect(Array.isArray(rows) ? rows[0] : undefined).toMatchObject({ one: 1 });
  });

  it('closes the pool, survives a second close, and opens a fresh one on demand', async () => {
    const first = getDb();
    await closeDb();

    // The pool is gone: the statement that was fine a moment ago now fails.
    await expect(first.db.execute(sql`select 1`)).rejects.toThrow();

    // Shutdown paths call this without knowing whether anything is open (PR-01's SIGTERM handler, a failed
    // boot, and this suite's teardown all do) — so a second close must not throw.
    await expect(closeDb()).resolves.toBeUndefined();

    const second = getDb();
    expect(second).not.toBe(first);
    await expect(second.db.execute(sql`select 1 as one`)).resolves.toBeDefined();
  });
});
