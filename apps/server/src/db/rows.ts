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

/**
 * The rows out of a raw `db.execute(sql`…`)`.
 *
 * drizzle hands back whatever the driver produced, and depending on the version that is the array of rows
 * itself or an object carrying them under `rows` — the same two shapes `src/test/helpers/db.ts`'s `catalogRows`
 * has to accept for the schema tests. PR-09's recursive walks (`folders.repo.ts`'s depth, height and tree
 * statements) are the first **application** code to read a raw statement, so the tolerance lives here once
 * rather than in every repository that grows one.
 *
 * Type parameters are unchecked here by necessity: a raw statement's result is only typed by the caller's
 * assertion, which is the trade for writing SQL drizzle cannot express. Never widen this into a parser.
 */
export function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { readonly rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
