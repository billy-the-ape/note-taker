/**
 * `services/settings.service.ts` over a real Postgres (docs/plans/mvp/MVP-09.md §5.7, §7).
 *
 * The one property worth a database here is the get-or-create. A missing `settings` row is a *legal* state the
 * schema allows (§2 of `docs/DATA-MODEL.md`: the pair is written by `insertUserWithSettings`, and there is no
 * trigger enforcing it), so PR-04's fixtures can produce a user with no settings row, and plan §9.2 #22 says the
 * two endpoints may never answer 404 because of it. That makes "the row is created, exactly once, by the request
 * that needed it" a claim about a unique constraint and two concurrent statements — which a unit test with a
 * mocked repository can only assert in shape, not in fact.
 *
 * The column defaults are asserted from the response rather than from the contract, because `autosave = true` and
 * `theme = 'system'` are the *database's* defaults (`settings_autosave_default`, `settings_theme_default`), and
 * the two are allowed to disagree only until someone notices.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { createSettingsService } from './settings.service.js';

const db = testDb();
const settings = createSettingsService({ db });

beforeEach(async () => {
  await resetDb();
});

/** Every `settings` row for one user, straight from the table. */
async function rowsFor(userId: string): Promise<{ autosave: boolean; theme: string; user_id: string }[]> {
  const rows = await catalogRows(
    sql`select autosave, theme, user_id from settings where user_id = ${userId}`,
  );
  return rows.map((row) => ({
    autosave: Boolean(row.autosave),
    theme: String(row.theme),
    user_id: String(row.user_id),
  }));
}

/** Drops the row a real account would have, i.e. reproduces the fixture/restore state §9.2 #22 is about. */
async function deleteSettingsRow(userId: string): Promise<void> {
  await catalogRows(sql`delete from settings where user_id = ${userId}`);
}

describe('GET /api/settings (§9.2 #22)', () => {
  it('creates the missing row on read, with the column defaults, and never a second one', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    await deleteSettingsRow(user.id);
    expect(await rowsFor(user.id)).toHaveLength(0);

    const first = await settings.get({ userId: user.id });
    expect(first).toEqual({ autosave: true, theme: 'system', updatedAt: expect.any(String) });

    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ autosave: true, theme: 'system', user_id: user.id });

    // A second read must not insert again, and must not pretend the row is new: the same `updatedAt` is the
    // proof that the ensure hit the conflict path rather than the insert path.
    const second = await settings.get({ userId: user.id });
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(await rowsFor(user.id)).toHaveLength(1);
  });

  it('answers for a user whose row was never there, and for one whose row is intact', async () => {
    const withRow = await createUser(db, { username: 'with-row', role: 'member' });
    const withoutRow = await createUser(db, { username: 'without-row', role: 'member' });
    await deleteSettingsRow(withoutRow.id);

    const intact = await settings.get({ userId: withRow.id });
    const created = await settings.get({ userId: withoutRow.id });

    expect(intact.theme).toBe('system');
    expect(created.theme).toBe('system');
    // One row each, and each belongs to its own user.
    expect(await rowsFor(withRow.id)).toHaveLength(1);
    const createdRows = await rowsFor(withoutRow.id);
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]?.user_id).toBe(withoutRow.id);
  });
});

describe('PATCH /api/settings (§9.2 #22)', () => {
  it('applies one field and leaves the other alone', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    await settings.get({ userId: user.id });

    const autosaveOff = await settings.patch({ userId: user.id, autosave: false });
    expect(autosaveOff.autosave).toBe(false);
    expect(autosaveOff.theme).toBe('system');

    const themed = await settings.patch({ userId: user.id, theme: 'dark' });
    expect(themed.theme).toBe('dark');
    // The earlier patch is still there: a partial update may not reset the field it was not told about.
    expect(themed.autosave).toBe(false);

    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ autosave: false, theme: 'dark', user_id: user.id });
  });

  it('creates the row when a patch arrives before any read has', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    await deleteSettingsRow(user.id);

    const patched = await settings.patch({ userId: user.id, theme: 'light' });
    expect(patched.theme).toBe('light');
    // The create is not a second insert next to the update: exactly one row, with the patch on it.
    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.theme).toBe('light');
  });

  it('leaves every field alone when the body named none, which the route refuses but the service survives', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const before = await settings.get({ userId: user.id });
    const after = await settings.patch({ userId: user.id });
    expect(after.theme).toBe(before.theme);
    expect(after.autosave).toBe(before.autosave);
    expect(await rowsFor(user.id)).toHaveLength(1);
  });

  it("touches only the caller's row", async () => {
    const a = await createUser(db, { username: 'a', role: 'member' });
    const b = await createUser(db, { username: 'b', role: 'member' });
    const bBefore = await settings.get({ userId: b.id });

    await settings.patch({ userId: a.id, theme: 'dark', autosave: false });

    const bAfter = await settings.get({ userId: b.id });
    expect(bAfter).toEqual(bBefore);
    expect((await rowsFor(a.id))[0]?.theme).toBe('dark');
    expect((await rowsFor(b.id))[0]?.theme).toBe('system');
  });
});
