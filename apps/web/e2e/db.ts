/**
 * The at-rest reader for scenario 7 (docs/plans/mvp/MVP-19.md §4, §5.7) — the DB leg of the MVP proof.
 *
 * **`postgres` (postgres.js), not a second `pg` client** (PR-19 §4): it is the driver `apps/server` already
 * ships (`apps/server/package.json`, pinned by PR-04 to 4.1.1), so the assertion cannot drift onto a driver
 * whose `bytea` decoding, transaction semantics or DSN parsing differ from the one that wrote the row. Because
 * pnpm does not expose one workspace's dependencies to another, it is declared as a **devDependency of
 * `apps/web` at that same version** — which is what lets a browser-level test look at a database column while
 * nothing production-facing gains a DB client. Playwright specs run in Node, so this connects directly to the
 * throwaway DSN the `webServer` is given (`e2e/env.ts`).
 *
 * **Read-only, in the database's own words.** Every read runs inside a transaction that begins
 * `SET TRANSACTION READ ONLY`, so an accidental `UPDATE` here is refused by Postgres rather than merely
 * discouraged by a comment — the module could not disturb a scenario even if it wanted to, and "the suite's
 * reader of the row is not the thing that wrote it" is enforced rather than asserted.
 *
 * **Never imported by app code.** It is a test-only module under `e2e/`, outside `src/`, so it is in no
 * `tsc` build, in no Vite graph, and in PR-18's image even less.
 */
import postgres, { type Sql } from 'postgres';

import { DATABASE_URL } from './env';

/**
 * The columns scenario 7 names, decoded the way the driver decodes them: `bytea` arrives as bytes
 * (postgres.js hands back a `Buffer`, which is a `Uint8Array`), and the comparison against the typed marker is
 * then a byte comparison rather than a string comparison over an encoding someone guessed.
 */
export interface NoteRowAtRest {
  readonly id: string;
  /** `notes.name` — plaintext on purpose (§5.7's accepted opposite: it is the documented search limitation). */
  readonly name: string;
  /** `notes.content_cipher` — the AES-256-GCM ciphertext with its 16-byte tag appended (`crypto/envelope.ts`). */
  readonly cipher: Uint8Array;
  /** `notes.content_iv` — 12 bytes, fresh per write. */
  readonly iv: Uint8Array;
  /** `notes.key_version` — which key of the keyring sealed *this* row. */
  readonly keyVersion: number;
  /** `notes.version` — bumped by a content write, never by a rotation. */
  readonly version: number;
}

let pool: Sql | undefined;

function client(): Sql {
  // Positional connection string, the way `apps/server/src/db/client.ts` passes it: postgres.js 4.1.1 parses the
  // DSN from the first argument, and an options object with a `url` key silently keeps the default port.
  pool ??= postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  return pool;
}

/**
 * `bytea` in this driver is a `Buffer`; `asBytes` keeps that a fact about the driver rather than a type lie, and
 * keeps the byte comparison in scenario 7 honest — a `Uint8Array` compared as bytes, never as somebody's guess
 * at an encoding of one.
 */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && value.startsWith('\\x')) {
    return Buffer.from(value.slice(2), 'hex');
  }
  throw new Error(`unexpected bytea shape from the driver: ${typeof value}`);
}

/**
 * One row, exactly as the database holds it. `null` when the id is not there — which is the honest answer to a
 * scenario that lost its own note, and is asserted as such by the caller rather than becoming an empty buffer.
 */
export async function readNoteAtRest(id: string): Promise<NoteRowAtRest | null> {
  const rows = await client().begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION READ ONLY');
    return await tx<RowAtRest[]>`
      select id, name, content_cipher, content_iv, key_version, version
        from notes
       where id = ${id}`;
  });
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    cipher: asBytes(row.content_cipher),
    iv: asBytes(row.content_iv),
    keyVersion: row.key_version,
    version: row.version,
  };
}

/** The shape `notes` has to the driver — snake_case, because this file reads the table, not the Drizzle type. */
interface RowAtRest {
  readonly id: string;
  readonly name: string;
  readonly content_cipher: unknown;
  readonly content_iv: unknown;
  readonly key_version: number;
  readonly version: number;
}

/** Closes the pool, so a finished run does not hold the only connection open between files. */
export async function closeTestDb(): Promise<void> {
  const open = pool;
  pool = undefined;
  if (open !== undefined) await open.end({ timeout: 1 });
}
