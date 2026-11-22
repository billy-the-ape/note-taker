/**
 * The user repository — the only place `users` is read or written (docs/plans/mvp/MVP-07.md §5/§6).
 *
 * Four things belong to this file and are not repeated anywhere else:
 *
 * * **The account and its settings row are one unit of work.** Every path that creates a user goes
 *   through {@link createUserWithSettings}, which inserts both rows in one transaction: PR-09's
 *   `settings.service.get()` is the belt for rows made *outside* it (a restore, a seed), never a
 *   substitute for it, and `settings.service.get()`'s get-or-create only saves a *reader*, not a user
 *   who cannot log in because their row arrived without one.
 * * **Usernames are looked up case-insensitively and stored exactly as typed.** `users_username_lower_uidx`
 *   is an index on `lower(username)`, so a service that compared `users.username` directly would let
 *   `Bob` sign in while `bob` exists — as a *different* user, with a different id and a different set of
 *   notes. The only comparison in this file is `lower(...) = lower(...)`.
 * * **The two unique indexes mean two different sentences.** A violation of `users_username_lower_uidx` is
 *   "that username is taken"; a violation of `users_one_owner_uidx` is "this install already has an owner",
 *   and the second one is the loser of a concurrent `/setup` race (plan §8: the guarantee is the index, not
 *   the `needsSetup` read). Both are `CONFLICT`; they are not the same message, and only `constraint_name`
 *   tells them apart — hence `db/pg-error.ts`.
 * * **`role` is passed, never defaulted.** The column defaults to `member` so a forgotten field cannot mint
 *   an owner, but a service that leaned on the default would be one schema change away from doing exactly
 *   that. `/setup` passes `'owner'`; every other path passes `'member'`.
 *
 * Deliberately **not** here: password hashing (`auth/passwords.ts` decides cost), sessions
 * (`sessions.repo.ts`), and any HTTP meaning — a `ConflictError` is a domain error this repository throws
 * because it knows which index fired, and `plugins/error-handler.ts` renders it.
 */
import { asc, eq, sql } from 'drizzle-orm';

import { ConflictError } from '../../domain/errors.js';
import type { Db, DbOrTx } from '../client.js';
import { newId } from '../ids.js';
import { constraintOf, isUniqueViolation } from '../pg-error.js';
import { expectOne, firstOrNone } from '../rows.js';
import { settings, type User, type UserRole, users } from '../schema.js';

/** The names this file maps, so they are spelled once. */
const USERNAME_INDEX = 'users_username_lower_uidx';
const ONE_OWNER_INDEX = 'users_one_owner_uidx';

export interface CreateUserIdentityInput {
  readonly username: string;
  /** The argon2id encoded string, already hashed by the caller (`auth/passwords.ts`). */
  readonly passwordHash: string;
  /** `'owner'` only ever comes from `/setup`; `POST /api/users` and `/register` pass `'member'`. */
  readonly role: UserRole;
  /** `null`/omitted stores `NULL`: the column is nullable, and the API returns it as `null` rather than absent. */
  readonly displayName?: string | null;
}

/**
 * The two inserts, without a transaction of their own.
 *
 * Split out from {@link createUserWithSettings} for exactly one reason: the atomicity claim in
 * `docs/DATA-MODEL.md` §6 ("one `settings` row per user, in the same transaction as the user") is only
 * testable by aborting a transaction *between* the two statements, and a function that opens its own
 * transaction cannot be embedded in one. Production calls the wrapper; the test calls this one inside a
 * transaction it rolls back.
 */
export async function insertUserWithSettings(
  executor: DbOrTx,
  input: CreateUserIdentityInput,
): Promise<User> {
  const inserted = await executor
    .insert(users)
    .values({
      id: newId(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      displayName: input.displayName ?? null,
    })
    .returning();
  const user = expectOne(inserted, 'insert into users');

  // One statement, one row, all defaults: `autosave=true`, `theme='system'`. If this throws, the user
  // insert above goes with it — which is the whole point of the pair living here.
  await executor.insert(settings).values({ userId: user.id });
  return user;
}

/**
 * Creates an account and its settings row, atomically, and translates the two unique violations that
 * mean something to a caller into {@link ConflictError}s with the right sentence.
 *
 * Any other failure — a CHECK, a foreign key, a database that is down — is rethrown untouched: the
 * global handler already maps those, and swallowing them here would be a 409 for a bug.
 */
export async function createUserWithSettings(db: Db, input: CreateUserIdentityInput): Promise<User> {
  try {
    return await db.transaction((tx) => insertUserWithSettings(tx, input));
  } catch (error) {
    throw mapUsernameOrOwnerConflict(error);
  }
}

/**
 * `23505` from either users index becomes a `CONFLICT`; anything else is not ours to reinterpret.
 *
 * The constraint name is logged by the handler rather than sent, but *which* name fired decides the
 * message a user sees, and "that username is taken" for a second-owner race would send someone hunting
 * for a duplicate account that does not exist.
 */
export function mapUsernameOrOwnerConflict(error: unknown): unknown {
  if (!isUniqueViolation(error)) return error;
  switch (constraintOf(error)) {
    case USERNAME_INDEX:
      return new ConflictError('that username is already taken', {
        details: [{ path: 'username', message: 'is already taken' }],
      });
    case ONE_OWNER_INDEX:
      // The concurrent-`/setup` loser, and the answer for a taken username above: plan §9.1 fixes nine codes and
      // none of them renders as 422, so both of these unique violations are a `CONFLICT` and
      // `docs/DATA-MODEL.md` §5 now says so rather than offering a code that does not exist.
      return new ConflictError('this instance already has an owner');
    default:
      return error;
  }
}

/**
 * Is this the `CONFLICT` this file creates for `users_username_lower_uidx`, and not the one it creates for
 * `users_one_owner_uidx`?
 *
 * The two arrive as the same class, and only the field detail says which index fired — which is exactly what
 * `POST /api/auth/register` needs, because a taken username is an attempt on the account list and earns an
 * `auth_attempts` row, while a second-owner race is a fact about the install. The coupling to the mapping above
 * is deliberate and it is one screen away: a caller that had to re-read the SQLSTATE would be reading an error
 * this module already interpreted, badly.
 */
export function isUsernameTakenConflict(error: unknown): boolean {
  return (
    error instanceof ConflictError && (error.details?.some((detail) => detail.path === 'username') ?? false)
  );
}

/**
 * True for a name the database can be asked about at all.
 *
 * `U+0000` is refused *inside* a Postgres text value (SQLSTATE 22021), so asking for `owner\0` does not return
 * "no such user" — the statement raises. `plugins/error-handler.ts` maps a code, not a message, and 22021 is
 * none of the three codes it knows, so that driver error would answer `500 INTERNAL` with an error-level log
 * line where plan §9.2 #5 promises one uniform `401` — from an unauthenticated request, on an endpoint whose
 * whole job is refusing guesses.
 *
 * Saying "not there" is not a workaround but the true answer: such a string cannot be an account
 * (`usernameSchema` is `[a-z0-9._-]`), and `undefined` is the answer every caller already renders as an
 * ordinary failed login. Enforcing it here, at the one username lookup, is also what makes
 * `reset-password.ts`'s lookup safe by the same stroke, rather than teaching each caller the rule.
 */
export function couldBeAnAccountName(username: string): boolean {
  return !username.includes('\0');
}

/**
 * The one username lookup in the codebase: case-insensitive, so `Bob` and `bob` are one account, and
 * parameterised so the `lower()` is a function over a bind value rather than a string anyone assembled.
 *
 * A name that {@link couldBeAnAccountName} refuses is answered as the miss it is, without a round trip.
 */
export async function userByUsername(db: Db, username: string): Promise<User | undefined> {
  if (!couldBeAnAccountName(username)) return undefined;
  const found = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);
  return firstOrNone(found);
}

/**
 * Every account, oldest first.
 *
 * `createdAt` alone is not a total order (two rows in the same millisecond), and ids are UUIDv7, so
 * ordering by id second makes the admin list stable without a second index.
 */
export async function listUsers(db: Db): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.createdAt), asc(users.id));
}

/**
 * Does an owner exist? This is `needsSetup` (plan §9.2 #2), and it is *not* "is `users` empty":
 * one `member` created by an errant `POST /api/users` must never be able to lock `/setup` out.
 */
export async function ownerExists(db: Db): Promise<boolean> {
  const found = await db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1);
  return found.length > 0;
}

/**
 * Replaces a password, and stamps `password_set_at` while it is there.
 *
 * That column is the only evidence an operator has of when a credential last changed, and a reset that
 * leaves it at row-creation time makes "has anyone rotated since the incident?" unanswerable. `undefined`
 * means the id was not there (a deleted user), and each caller refuses in its own terms rather than pretending
 * to know HTTP: `auth.service.ts` answers `401 UNAUTHORIZED` with "this account no longer exists", and
 * `reset-password.ts` writes `no account named <username>` to stderr and exits `1`.
 *
 * `DbOrTx`, because both of its callers have to be atomic: "the password changed and my other devices are
 * still signed in" is the failure this row is supposed to make impossible, so the write is one statement inside
 * a transaction whose other half deletes the sessions (`auth.service.ts`, `reset-password.ts`).
 */
export async function setUserPassword(
  executor: DbOrTx,
  input: { readonly userId: string; readonly passwordHash: string },
): Promise<User | undefined> {
  const now = new Date();
  const updated = await executor
    .update(users)
    .set({ passwordHash: input.passwordHash, passwordSetAt: now, updatedAt: now })
    .where(eq(users.id, input.userId))
    .returning();
  return firstOrNone(updated);
}
