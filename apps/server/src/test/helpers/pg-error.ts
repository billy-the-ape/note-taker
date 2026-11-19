/**
 * Getting at the SQLSTATE a failed statement actually carries (docs/plans/mvp/MVP-04.md §7).
 *
 * The whole error contract of PR-07…PR-10 is a map from Postgres's SQLSTATE to an HTTP status —
 * `23505 → 409`, `23503 → 400`, `23514 → 400`, `22P02 → 400`, `22001 → 413` — so the first thing that contract
 * needs is the code, and drizzle-orm does not hand it over on the error it throws: `DbError` wraps the driver's
 * error and rethrows a `DrizzleQueryError`, leaving the SQLSTATE (and the constraint name, and Postgres's own
 * message) on `error.cause`. Reading `error.code` returns `undefined`, which is how a missing constraint quietly
 * becomes a 500.
 *
 * These helpers read the whole `cause` chain, and `docs/DATA-MODEL.md` §7 records the same fact for the
 * services layer, which must use it rather than re-deriving it.
 */
import { expect } from 'vitest';

interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly constraint_name?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}

/**
 * The first error in the `cause` chain that looks like a Postgres error (a SQLSTATE beside a message).
 *
 * The `seen` set is not paranoia: an error whose `cause` points back at itself is easy to construct and would
 * otherwise spin here forever.
 */
function findPgError(error: unknown): PgErrorLike | undefined {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === 'object' && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as PgErrorLike;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') return candidate;
    cursor = candidate.cause;
  }
  return undefined;
}

/** The five-character SQLSTATE, wherever it is: `23505`, `23503`, `23514`, …, or `undefined`. */
export function sqlStateOf(error: unknown): string | undefined {
  const found = findPgError(error);
  return typeof found?.code === 'string' ? found.code : undefined;
}

/** The constraint that fired (`folders_unique_sib`), which is how a test names the index it means. */
export function constraintOf(error: unknown): string | undefined {
  const found = findPgError(error);
  const named = found?.constraint ?? found?.constraint_name;
  return typeof named === 'string' ? named : undefined;
}

/** Postgres's own words, with the failing row in `detail` — for the log, never for a response body (PR-02). */
export function pgMessageOf(error: unknown): string | undefined {
  const found = findPgError(error);
  return typeof found?.message === 'string' ? found.message : undefined;
}

/**
 * Awaits a statement that must fail with SQLSTATE `code` — and, when `constraint` is given, fired by that
 * constraint — and returns the error so a test can say more about it.
 *
 * A statement that *succeeds* fails the test with this sentence rather than with a confusing `undefined`.
 */
export async function expectSqlState(
  statement: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<unknown> {
  const outcome = await statement.then(
    (value) => ({ succeeded: true as const, value }),
    (error: unknown) => ({ succeeded: false as const, error }),
  );
  const where = constraint === undefined ? '' : ` from constraint ${constraint}`;
  if (outcome.succeeded) {
    throw new Error(`expected SQLSTATE ${code}${where}, but the statement succeeded`);
  }

  expect(sqlStateOf(outcome.error)).toBe(code);
  if (constraint !== undefined) expect(constraintOf(outcome.error)).toBe(constraint);
  return outcome.error;
}
