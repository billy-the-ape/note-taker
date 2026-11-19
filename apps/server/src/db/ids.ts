/**
 * The one id generator in the repository (docs/plans/mvp/MVP-04.md §4).
 *
 * **Every insert of a PK goes through this function**, so ids are UUIDv7: 48 bits of millisecond timestamp
 * followed by random bits, which means they sort in insertion order and keep B-tree inserts append-only
 * instead of scattering writes across the whole index. There is no SQL default for `id` in `db/schema.ts`
 * either, so a row cannot be created with an id this function did not mint — and nothing in the MVP has a
 * second source of ids to fall out of sync with.
 *
 * The package is `uuid` (the uuidjs library) and its `v7`. The brief named `@uuidjs/uuid-v7`, which has
 * never existed on the registry; `uuid` is the same project and exports `v7` directly (see
 * `docs/DATA-MODEL.md`, "Decisions"). Node's built-in `crypto.randomUUID()` would be the acceptable fallback
 * the brief allows (it is v4, and nothing in the MVP orders rows by id), but it is not needed.
 */
import { v7 as uuidv7 } from 'uuid';

/**
 * A new UUIDv7 as the canonical lowercase string, which is what the `uuid` columns store.
 *
 * A string (not a `UUID` object) on purpose: Drizzle's `uuid()` columns, Postgres' `uuid` type, JSON
 * responses and `COALESCE(parent_id, '00000000-…'::uuid)` all want that representation already.
 */
export function newId(): string {
  return uuidv7();
}
