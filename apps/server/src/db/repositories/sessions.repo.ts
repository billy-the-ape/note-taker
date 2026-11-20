/**
 * The session repository — the only place `sessions` is read or written (docs/plans/mvp/MVP-07.md §5).
 *
 * A session is a row keyed by **`sha256(token)`**, so every lookup here is by hash and every statement is
 * written as though the database had already been copied to a USB stick, because one day it will be: from a
 * dump of this table an attacker can neither sign a cookie (the raw token is nowhere in it) nor extend a
 * session (they can read `expires_at`, not change it into a valid credential for another user).
 *
 * Three rules the rest of the auth code leans on:
 *
 * * **Expiry is decided by the caller's clock, and only the caller's.** `sessionOwnerByTokenHash` returns
 *   expired rows: the guard needs to tell "this cookie names a session that has aged out" (delete it, answer
 *   signed-out) from "this cookie names nothing" (answer signed-out), and `GET /api/auth/session` needs the row
 *   to decide what to report. Filtering in SQL would delete that distinction and add a `now()` to every request.
 * * **`rotateSessionToken` updates the primary key.** That is what makes rotation observable from the row:
 *   after `POST /api/auth/password` the *same* session — same `created_at`, same user-agent — answers to a
 *   different token, so "the acting session survived" and "the old cookie is dead" are both true at once.
 *   Deleting and re-inserting would be the same HTTP answer and a worse audit trail.
 * * **Deleting everything but one is one statement.** "Sign out everywhere" and the password change both
 *   need it, and a loop over rows would leave a window where a concurrent login slipped through.
 *
 * No `user_id` scoping: a session's owner comes back with the row, and the *caller* has already proven the
 * cookie. There is nothing here a second user could use to read someone else's notes.
 */
import { and, eq, ne } from 'drizzle-orm';

import type { Db } from '../client.js';
import { expectOne, firstOrNone } from '../rows.js';
import { type Session, sessions, type User, users } from '../schema.js';

export interface IssueSessionInput {
  /** `sha256(rawToken)` — see `auth/tokens.ts`. The raw value never reaches this file. */
  readonly tokenHash: Uint8Array;
  readonly userId: string;
  /** `now + SESSION_TTL_DAYS`, so the cookie and the row agree without either reading the other. */
  readonly expiresAt: Date;
  /** `User-Agent`, truncated to the first 256 characters: it is a hint for a human reading the table,
   *  and a 64 KiB UA header is a reason not to store the field at all. */
  readonly userAgent?: string | null;
}

/** A session and the user it belongs to, which is everything an authenticated request needs. */
export interface SessionOwner {
  readonly session: Session;
  readonly user: User;
}

/** The maximum length of the `user_agent` hint (see {@link IssueSessionInput.userAgent}). */
const USER_AGENT_MAX_LENGTH = 256;

/** Creates a session row. Nothing else needs to exist first beyond the user, which the FK enforces. */
export async function issueSession(db: Db, input: IssueSessionInput): Promise<Session> {
  const userAgent =
    input.userAgent === null || input.userAgent === undefined
      ? null
      : input.userAgent.slice(0, USER_AGENT_MAX_LENGTH);

  const inserted = await db
    .insert(sessions)
    .values({
      tokenHash: input.tokenHash,
      userId: input.userId,
      expiresAt: input.expiresAt,
      userAgent,
    })
    .returning();
  return expectOne(inserted, 'insert into sessions');
}

/**
 * The row a cookie names, expired or not, with the user joined in — see the module note for why "expired or
 * not" is the right answer, and note that the `bytea` comparison is a bound parameter rather than a hex string
 * anyone built, which is also what makes the primary-key index usable.
 *
 * This is the shape the auth guard hands to every route: one round trip per request, and no second query for a
 * user the session already names. It is deliberately the *only* read of a single session in this file: a
 * session-row-only variant would be a second, uncalled way to answer the same question, and the joined answer is
 * the one every caller here needs anyway.
 */
export async function sessionOwnerByTokenHash(
  db: Db,
  tokenHash: Uint8Array,
): Promise<SessionOwner | undefined> {
  const found = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  const row = firstOrNone(found);
  return row === undefined ? undefined : { session: row.session, user: row.user };
}

/**
 * Records that this session was just used.
 *
 * `last_seen_at` is a *column*, not a promise: the guard only calls this when the stored value is minutes
 * old (see `plugins/auth-guard.ts`), because an authenticated SPA makes a dozen requests per interaction and
 * a write per request would make the settings page's own polling the busiest writer in the database.
 */
export async function touchSession(
  db: Db,
  tokenHash: Uint8Array,
  seenAt: Date = new Date(),
): Promise<Session | undefined> {
  const updated = await db
    .update(sessions)
    .set({ lastSeenAt: seenAt })
    .where(eq(sessions.tokenHash, tokenHash))
    .returning();
  return firstOrNone(updated);
}

/**
 * Gives an existing session a new token hash, keeping everything else.
 *
 * Updating a primary key looks like a smell until the alternative is compared against it: delete-then-insert
 * loses `created_at` (when did this device first sign in?) and `user_agent`, and would make
 * "the acting session survives the password change" a sentence about the HTTP response rather than about the
 * row. Postgres rewrites the row and re-indexes it; there is one row per session and one update per
 * password change, so the cost is nothing and the meaning is exact.
 */
export async function rotateSessionToken(
  db: Db,
  input: { readonly fromTokenHash: Uint8Array; readonly toTokenHash: Uint8Array; readonly expiresAt: Date },
): Promise<Session | undefined> {
  const updated = await db
    .update(sessions)
    .set({ tokenHash: input.toTokenHash, expiresAt: input.expiresAt, lastSeenAt: new Date() })
    .where(eq(sessions.tokenHash, input.fromTokenHash))
    .returning();
  return firstOrNone(updated);
}

/** One session out — `logout`, and the expired row the guard found but the cookie still carries. */
export async function deleteSessionByTokenHash(db: Db, tokenHash: Uint8Array): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length > 0;
}

/**
 * Every session of one user, optionally keeping the one that is asking.
 *
 * Two callers, both of them "sign me out of everywhere else": `POST /api/auth/logout-all` (keep nothing) and
 * `POST /api/auth/password` (keep the acting session, which is then rotated by {@link rotateSessionToken}).
 * Returning the count is what lets the routes and the tests say *how many* devices stopped working, which is
 * the difference between a 204 and a 204 that did nothing.
 */
export async function deleteSessionsOfUser(
  db: Db,
  input: { readonly userId: string; readonly exceptTokenHash?: Uint8Array },
): Promise<number> {
  const where =
    input.exceptTokenHash === undefined
      ? eq(sessions.userId, input.userId)
      : and(
          eq(sessions.userId, input.userId),
          // `token_hash <> $1` on `bytea` is a byte comparison; `ne` is how drizzle spells "not equal"
          // without reaching for `sql`, and the null-free column means it cannot silently match nothing.
          ne(sessions.tokenHash, input.exceptTokenHash),
        );

  const deleted = await db.delete(sessions).where(where).returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
