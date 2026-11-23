/**
 * `GET`/`PATCH /api/settings` on the wire (docs/plans/mvp/MVP-09.md §4 #21–#22, §7).
 *
 * Two things are worth an HTTP test here that the service test cannot see:
 *
 * * **The missing row never reaches the client as a 404.** Plan §9.2 #22 makes settings the one resource where a
 *   row that does not exist is *not* an error, and the only way to prove that on the wire is to delete the row
 *   under a live session and ask again. The answer must be the defaults, and the table must end up with exactly
 *   one row — not two, which is what a naive `insert`-then-`update` would leave after the second read.
 * * **The patch is partial.** A client that sends `{ theme }` must not have its `autosave` reset by a server-side
 *   default, and a body that names nothing is a client bug the contract's schema refuses with `400 VALIDATION`
 *   rather than a silent no-op `200`.
 */
import { apiErrorCodeForStatus, ROUTES, settingsSchema } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { withApp } from '../test/helpers/app.js';
import { jarHeaders } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { bootstrapOwner, createMember, envelopeOf, whoAmI } from '../test/helpers/session.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

/** The caller's `settings` rows, read straight from the table. */
async function settingRows(userId: string): Promise<{ autosave: boolean; theme: string }[]> {
  const rows = await catalogRows(sql`select autosave, theme from settings where user_id = ${userId}`);
  return rows.map((row) => ({ autosave: Boolean(row.autosave), theme: String(row.theme) }));
}

describe('GET /api/settings (§9.2 #22)', () => {
  it('creates the row it needed, on the wire, exactly once', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const userId = await whoAmI(app, owner);
        // The user was created through `/setup`, which writes the settings pair. Remove it: the state a restored
        // dump or a hand-repaired row leaves, and the one state §9.2 #22 says may never be a 404.
        await catalogRows(sql`delete from settings where user_id = ${userId}`);
        expect(await settingRows(userId)).toHaveLength(0);

        const first = await app.inject({ method: 'GET', url: ROUTES.settings, headers: jarHeaders(owner) });
        expect(first.statusCode, first.body).toBe(200);
        expect(settingsSchema.parse(first.json())).toEqual({
          autosave: true,
          theme: 'system',
          updatedAt: expect.any(String),
        });
        expect(await settingRows(userId)).toHaveLength(1);

        // A second read may not insert again: that is the difference between "ensure" and "insert".
        const second = await app.inject({ method: 'GET', url: ROUTES.settings, headers: jarHeaders(owner) });
        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual(first.json());
        expect(await settingRows(userId)).toHaveLength(1);
      },
      { db },
    );
  });

  it('refuses an anonymous request with 401, and writes nothing for anybody', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const anonymous = await app.inject({ method: 'GET', url: ROUTES.settings });
        expect(anonymous.statusCode).toBe(401);
        expect(envelopeOf(anonymous).code).toBe('UNAUTHORIZED');

        const patched = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          payload: { theme: 'dark' },
        });
        expect(patched.statusCode).toBe(401);

        const rows = await catalogRows(sql`select count(*)::int as n from settings`);
        expect(rows[0]?.n).toBe(0);
      },
      { db },
    );
  });
});

describe('PATCH /api/settings (§9.2 #22)', () => {
  it('applies one field and leaves the other, for one user and only that user', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const member = await createMember(app, owner, { username: 'member' });

        const autosave = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          headers: jarHeaders(owner),
          payload: { autosave: false },
        });
        expect(autosave.statusCode, autosave.body).toBe(200);
        expect(settingsSchema.parse(autosave.json()).autosave).toBe(false);

        const themed = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          headers: jarHeaders(owner),
          payload: { theme: 'dark' },
        });
        expect(themed.statusCode, themed.body).toBe(200);
        const settings = settingsSchema.parse(themed.json());
        expect([settings.theme, settings.autosave]).toEqual(['dark', false]);

        // The member is untouched by all of that, and their row was never created by somebody else's patch.
        const theirs = await app.inject({ method: 'GET', url: ROUTES.settings, headers: jarHeaders(member) });
        expect(settingsSchema.parse(theirs.json())).toMatchObject({ autosave: true, theme: 'system' });
        expect(await settingRows(await whoAmI(app, owner))).toEqual([{ autosave: false, theme: 'dark' }]);
      },
      { db },
    );
  });

  it('refuses a theme the contract does not know, and a body that names no field', async () => {
    await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const before = await app.inject({ method: 'GET', url: ROUTES.settings, headers: jarHeaders(owner) });

        const badTheme = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          headers: jarHeaders(owner),
          payload: { theme: 'sepia' },
        });
        expect(badTheme.statusCode).toBe(400);
        expect(envelopeOf(badTheme).code).toBe(apiErrorCodeForStatus(400));

        const empty = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          headers: jarHeaders(owner),
          payload: {},
        });
        expect(empty.statusCode).toBe(400);
        expect(envelopeOf(empty).code).toBe('VALIDATION');

        const notAnObject = await app.inject({
          method: 'PATCH',
          url: ROUTES.settings,
          headers: jarHeaders(owner),
          payload: 'dark',
        });
        expect(notAnObject.statusCode).toBe(400);

        // None of the three changed a byte.
        const after = await app.inject({ method: 'GET', url: ROUTES.settings, headers: jarHeaders(owner) });
        expect(after.json()).toEqual(before.json());
      },
      { db },
    );
  });
});
