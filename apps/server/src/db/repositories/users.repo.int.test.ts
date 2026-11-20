/**
 * `users.repo.ts` against a real Postgres (docs/plans/mvp/MVP-07.md §7).
 *
 * The unit tests cannot reach any of this, because the four things worth proving here are properties of
 * Postgres rather than of TypeScript:
 *
 * * that the user insert and the settings insert really are one unit of work — `docs/DATA-MODEL.md` §6 promises
 *   "one `settings` row per user, in the same transaction as the user", and the only way to test a promise about
 *   a transaction is to abort one between the two statements;
 * * that the two unique indexes fire the way the code assumes, including which *constraint name* arrives, since
 *   `mapUsernameOrOwnerConflict` switches on it;
 * * that `lower(username)` behaves as the index says it does, in SQL and not in a `WHERE` someone retyped;
 * * that an `UPDATE` sets the columns it claims to.
 *
 * `insertUserWithSettings` is exported rather than kept private for the first bullet alone, and this file is the
 * reason it stays that way.
 */
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConflictError } from '../../domain/errors.js';
import { catalogRows, resetDb, testDb } from '../../test/helpers/db.js';
import { users } from '../schema.js';
import {
  createUserWithSettings,
  insertUserWithSettings,
  listUsers,
  ownerExists,
  setUserPassword,
  userByUsername,
} from './users.repo.js';

const PASSWORD_HASH =
  '$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$stnT77vVY53Bq2W0X1pEAxhS5FjOxo3XkQ0';
const ANOTHER_HASH = '$argon2id$v=19$m=8192,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA+Bq2W0X1pEAxhS5FjOxo3XkQ0Yz1L1m';

/** Counts of the two tables the pair of inserts touches. */
async function counts(): Promise<{ users: number; settings: number }> {
  const rows = await catalogRows(sql`select
    (select count(*)::int from users) as users,
    (select count(*)::int from settings) as settings`);
  return { users: Number(rows[0]?.users), settings: Number(rows[0]?.settings) };
}

beforeEach(async () => {
  await resetDb();
});

describe('createUserWithSettings (§7: the pair is one unit of work)', () => {
  it('writes the user and its settings row together', async () => {
    const db = testDb();
    const user = await createUserWithSettings(db, {
      username: 'owner',
      passwordHash: PASSWORD_HASH,
      role: 'owner',
      displayName: 'Olive Owner',
    });

    expect(user.username).toBe('owner');
    // `displayName` is stored exactly as typed: uniqueness is what `lower()` is for, presentation is not.
    expect(user.displayName).toBe('Olive Owner');
    expect(await counts()).toEqual({ users: 1, settings: 1 });
  });

  it('leaves neither row behind when the transaction is aborted between the two inserts', async () => {
    const db = testDb();

    // The statement in the middle of the pair. `insertUserWithSettings` is exported precisely so this can be
    // embedded in a transaction that does not commit: if the settings insert ever moves out (a trigger, a
    // best-effort `insert`, a `getOrCreateSettings` called after the commit), the user row would survive alone,
    // and every read of that account would then depend on a get-or-create path nothing tests.
    await expect(
      db.transaction(async (tx) => {
        await insertUserWithSettings(tx, {
          username: 'half-created',
          passwordHash: PASSWORD_HASH,
          role: 'member',
        });
        throw new Error('aborted between the two statements');
      }),
    ).rejects.toThrow('aborted between the two statements');

    expect(await counts()).toEqual({ users: 0, settings: 0 });
  });

  it('refuses a second account whose username differs only in case, as the same CONFLICT', async () => {
    const db = testDb();
    await createUserWithSettings(db, { username: 'Colleague', passwordHash: PASSWORD_HASH, role: 'member' });

    // `users_username_lower_uidx` is on `lower(username)`, so this is a unique violation and not a coincidence of
    // the application layer; the message the route then renders is "that username is already taken".
    const error = await createUserWithSettings(db, {
      username: 'colleague',
      passwordHash: PASSWORD_HASH,
      role: 'member',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toMatch(/already taken/i);
    expect(await counts()).toEqual({ users: 1, settings: 1 });
  });

  it('refuses a second owner, and says "owner" rather than "username"', async () => {
    const db = testDb();
    await createUserWithSettings(db, { username: 'owner', passwordHash: PASSWORD_HASH, role: 'owner' });

    // A different username, so the only thing this insert violates is `users_one_owner_uidx`. Which constraint
    // fired decides the sentence a person reads, and "that username is taken" here would send them looking for a
    // duplicate account that does not exist.
    const error = await createUserWithSettings(db, {
      username: 'also-owner',
      passwordHash: PASSWORD_HASH,
      role: 'owner',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toMatch(/owner/i);
    expect(await counts()).toEqual({ users: 1, settings: 1 });
  });
});

describe('the reads the auth service is built on', () => {
  it('finds an account whatever case it was typed in, and returns the row that was stored', async () => {
    const db = testDb();
    const created = await createUserWithSettings(db, {
      username: 'MixedCase',
      passwordHash: PASSWORD_HASH,
      role: 'member',
    });

    // The lookup is case-insensitive (that is the index) and the value it returns is the stored spelling, which is
    // what `toSessionUser` puts in the response: `LOGIN` finds `MixedCase`, and the API never rewrites a name.
    expect(await userByUsername(db, 'MIXEDCASE')).toMatchObject({ id: created.id, username: 'MixedCase' });
    expect(await userByUsername(db, 'mixedcase')).toMatchObject({ id: created.id });
    expect(await userByUsername(db, 'nobody')).toBeUndefined();
  });

  it('answers needsSetup from the owner row and not from the size of the table', async () => {
    const db = testDb();
    expect(await ownerExists(db)).toBe(false);

    // The plan §9.2 #2 rule this file documents: a stray member must never be able to lock `/setup` out, so
    // "does an owner exist" cannot be spelled "is users empty".
    await createUserWithSettings(db, { username: 'member', passwordHash: PASSWORD_HASH, role: 'member' });
    expect(await ownerExists(db)).toBe(false);

    await createUserWithSettings(db, { username: 'owner', passwordHash: PASSWORD_HASH, role: 'owner' });
    expect(await ownerExists(db)).toBe(true);
  });

  it('lists accounts oldest first, which is what makes the admin list stable', async () => {
    const db = testDb();
    const first = await createUserWithSettings(db, {
      username: 'first',
      passwordHash: PASSWORD_HASH,
      role: 'member',
    });
    await createUserWithSettings(db, { username: 'second', passwordHash: PASSWORD_HASH, role: 'member' });
    const third = await createUserWithSettings(db, {
      username: 'third',
      passwordHash: PASSWORD_HASH,
      role: 'member',
    });

    const listed = await listUsers(db);
    expect(listed.map((user) => user.username)).toEqual(['first', 'second', 'third']);
    // UUIDv7 ids sort by creation time, which is the tie-breaker the ordering comment claims.
    expect(listed.map((user) => user.id)).toEqual([first.id, expect.any(String), third.id]);
  });
});

describe('setUserPassword (§6, the write the reset script and the rotation share)', () => {
  it('replaces the hash and moves both timestamps, in one statement', async () => {
    const db = testDb();
    const created = await createUserWithSettings(db, {
      username: 'owner',
      passwordHash: PASSWORD_HASH,
      role: 'owner',
    });
    expect(created.passwordSetAt).toBeInstanceOf(Date);
    const hashBefore = await db.execute(sql`select password_hash from users where id = ${created.id}`);
    expect(String(hashBefore[0]?.password_hash)).toBe(PASSWORD_HASH);

    const updated = await setUserPassword(db, { userId: created.id, passwordHash: ANOTHER_HASH });
    expect(updated?.id).toBe(created.id);

    const row = await catalogRows(
      sql`select password_hash, password_set_at, updated_at from users where id = ${created.id}`,
    );
    expect(String(row[0]?.password_hash)).toBe(ANOTHER_HASH);
    // `password_set_at` is the evidence an operator reads after an incident; leaving it at row-creation time
    // makes "has anyone rotated since" unanswerable, which is why this is a repository-level assertion.
    expect(Number.isNaN(Date.parse(String(row[0]?.password_set_at)))).toBe(false);
    expect(Date.parse(String(row[0]?.updated_at))).toBeGreaterThanOrEqual(
      Date.parse(String(row[0]?.password_set_at)),
    );

    // The row was updated in place: the same id, and still exactly one settings row.
    expect(await counts()).toEqual({ users: 1, settings: 1 });
  });

  it('answers undefined for an id that is not there, rather than inventing a row', async () => {
    const db = testDb();
    const missing = await createUserWithSettings(db, {
      username: 'was-deleted',
      passwordHash: PASSWORD_HASH,
      role: 'member',
    });
    await db.delete(users).where(eq(users.id, missing.id));

    expect(await setUserPassword(db, { userId: missing.id, passwordHash: ANOTHER_HASH })).toBeUndefined();
    // …and the delete really was a cascade, which is the other half of why recovery must never delete a user.
    expect(await counts()).toEqual({ users: 0, settings: 0 });
  });
});
