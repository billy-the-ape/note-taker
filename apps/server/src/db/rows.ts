/**
 * Unwraps the results Drizzle hands back, without a single non-null assertion (Biome's
 * `noNonNullAssertion` is on for `src`, off only for tests).
 *
 * `noUncheckedIndexedAccess` makes every array index `T | undefined`, which is correct in general and noisy
 * for the two shapes a repository actually writes: a single-row `insert … returning` and a
 * `select … limit 1`. Those two get a named helper here instead of an inline `!` at 40 call sites.
 */

/**
 * The single-row case: `insert … returning` / `update … returning` on a statement the caller has already
 * scoped to one row.
 *
 * @throws {Error} if the statement returned nothing, which means the row was deleted concurrently — a bug or
 *   a race in the caller, never a value to hand back as data.
 */
export function expectOne<T>(rows: readonly T[], what: string): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error(`expected exactly one row back from ${what}, got ${String(rows.length)}`);
  }
  return first;
}

/** The optional-row case: `select … limit 1` finds nothing, and `undefined` is the answer (404 at the edge). */
export function firstOrNone<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}
