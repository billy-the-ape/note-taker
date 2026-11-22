/**
 * Reading what Postgres actually said, from application code (docs/DATA-MODEL.md §5).
 *
 * drizzle-orm catches the driver's error and rethrows its own `DrizzleQueryError`, so **the SQLSTATE is
 * on `error.cause.code`** and reading `error.code` on the thrown object returns `undefined`. That is the
 * one fact every constraint-mapping in this repository depends on; `plugins/error-handler.ts` already
 * walks the chain for the generic `23505 → 409` mapping, and `src/test/helpers/pg-error.ts` does the same
 * for the tests (it cannot be imported here — it imports `expect` from Vitest), so this is the third
 * copy of a two-line walk and the deliberately-dumb half of the contract: no mapping, just retrieval.
 *
 * `constraint_name` is the other half. Two indexes on the same table with the same SQLSTATE mean
 * different sentences to a user — `users_username_lower_uidx` is "that username is taken", while
 * `users_one_owner_uidx` is "this install already has an owner" — and only the name tells them apart.
 */

interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly constraint_name?: unknown;
  readonly cause?: unknown;
}

/**
 * The first error in the `cause` chain that carries a SQLSTATE.
 *
 * The `seen` set is not paranoia: an error whose `cause` points back at itself is trivial to construct,
 * and a loop here would hang a request instead of answering it.
 */
function findPgError(error: unknown): PgErrorLike | undefined {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === 'object' && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as PgErrorLike;
    if (typeof candidate.code === 'string') return candidate;
    cursor = candidate.cause;
  }
  return undefined;
}

/** The five-character SQLSTATE (`23505`, `23503`, …) wherever it is in the chain, or `undefined`. */
export function sqlStateOf(error: unknown): string | undefined {
  const found = findPgError(error);
  return typeof found?.code === 'string' ? found.code : undefined;
}

/** The index that fired (`users_username_lower_uidx`), which is how a `23505` knows what it means. */
export function constraintOf(error: unknown): string | undefined {
  const found = findPgError(error);
  // postgres.js v4 spells it `constraint_name`; other drivers, and drizzle's own wrapper in some
  // versions, use `constraint`. Both are read, exactly as `docs/DATA-MODEL.md` §5 says they must be.
  const named = found?.constraint ?? found?.constraint_name;
  return typeof named === 'string' ? named : undefined;
}

/** The SQLSTATE this application maps in `plugins/error-handler.ts`: unique violation. */
export const UNIQUE_VIOLATION = '23505';

/** Was it a unique violation? The name of the index then says which one, and the caller decides the message. */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}
