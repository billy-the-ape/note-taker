/**
 * `auth_attempts`: one row per credential outcome (docs/plans/mvp/MVP-07.md §5, plan §10).
 *
 * This table is the **durable half** of the brute-force story. `http/rate-limit.ts` is what refuses the
 * eleventh attempt and knows *now*; this is what an operator queries the morning after an incident to find out
 * who was attacked, how often, and whether it worked.
 *
 * **There is deliberately no reader here.** The limiter does not consult the table — blocking from the database
 * would mean two statements on every login where the in-memory window needs none, and a lockout that a process
 * restart forgets; plan §10 asks for a sliding window *plus* audit rows, not one implemented as the other. And
 * no route reports it in the MVP. A `countRecentAttempts()` would be dead code with a plausible name, so it is
 * not here: the PR that builds a lockout report or a retention job adds its reader next to this one, when it
 * has a caller. Rows therefore have no retention rule yet (the `auth_attempts` note in `docs/DATA-MODEL.md` §2
 * says so too, and names the index a future prune would use).
 *
 * Two facts the write keeps:
 *
 * * `user_key` is {@link attemptKey} — `lower(username)` — because `users_username_lower_uidx` decides that
 *   `Bob` and `bob` are one account, and an audit trail that disagreed with the index would split one attack
 *   across two names. The column also holds a bare IP for an attempt that named no account; both shapes are
 *   text, and neither is a foreign key on purpose (the row has to outlive the account it names).
 * * A row for a **failure** is a fact about the world, so the caller writes it *before* throwing, and the
 *   insert is never inside a transaction anything else rolls back.
 */
import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { authAttempts } from '../schema.js';

export interface RecordAuthAttemptInput {
  /** `lower(username)`, as {@link attemptKey} produces it. */
  readonly userKey: string;
  /** Whether the credential checked out. A request the limiter refused is not recorded at all. */
  readonly succeeded: boolean;
}

/**
 * The `lower(username)` an attempt is keyed by; see this file's header for why it is not the raw username.
 *
 * A NUL (U+0000) is the one character this column cannot hold (SQLSTATE 22021), and it is reachable here
 * because `loginSchema` is deliberately permissive (plan §9.2 #5): `userByUsername` answers a name containing
 * one as the miss it is, and this row is written next to that uniform `401`. Writing U+FFFD instead keeps the
 * row — "someone probed `owner\0` at 03:00" is precisely the fact this table exists to hold, and the `catch` in
 * {@link recordAuthAttempt} would otherwise swallow the failed insert **silently, forever**. A real username is
 * `[a-z0-9._-]` (`usernameSchema`), so the substitution cannot collide with an account that exists.
 */
export function attemptKey(username: string): string {
  return username.toLowerCase().replaceAll('\0', '\uFFFD');
}

/**
 * Inserts the audit row, and swallows a failure to insert it.
 *
 * That swallowing is the sharp edge, so the reasoning is written down: the row is *about* the request, not part
 * of it. If the insert fails — disk full, connection lost — the login outcome has not changed, and surfacing
 * the failure would turn an infrastructure hiccup into either a `500` on a correct password or a generic `401`
 * on a wrong one. The rate limiter is in memory and unaffected, so the protection itself is not weakened; what
 * is lost is one row. The caller logs nothing either, because the request that could not insert is exactly the
 * request whose log line will be read in court; the row's absence is the evidence.
 *
 * The swallow is also why the insert is written out plainly and covered by a test: `auth_attempts.id` has no
 * database default (ids come from `newId()`, `docs/DATA-MODEL.md` §2), so a missing `id` here is a `NOT NULL`
 * violation that this `catch` would eat and the audit table would stay empty **forever, silently**. The
 * assertion in `routes/auth.routes.int.test.ts` that counts ten failed rows is the only thing between that bug
 * and a merge.
 */
export async function recordAuthAttempt(db: Db, input: RecordAuthAttemptInput): Promise<void> {
  await db
    .insert(authAttempts)
    .values({ id: newId(), userKey: input.userKey, succeeded: input.succeeded })
    .execute()
    .catch(() => undefined);
}
