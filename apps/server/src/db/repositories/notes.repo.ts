/**
 * The note repository (docs/plans/mvp/MVP-04.md §5).
 *
 * **It never sees plaintext and never holds a key.** `notes.content_cipher`/`content_iv`/`key_version` are one
 * opaque triple that the caller hands over already sealed, because the schema has no plaintext representation
 * at all — there is no column, flag, or code path that could store a note in the clear in any environment.
 * PR-06's `crypto/envelope.ts` is what produces that triple (`sealNoteContent()` returns exactly a
 * `SealedContent`; `envelope.test.ts` assigns one to this type so the two shapes cannot drift silently),
 * PR-04's tests here still insert fixed test blobs through the same interface because this layer must not care
 * which envelope it is holding, and PR-09/PR-10 call the same functions from the services.
 *
 * Like `folders.repo.ts`: `db` is injected, every statement is scoped by `user_id` (someone else's note is
 * "not found", a 404), and `folderId: null` is the root — where `notes_unique_sib` compares
 * `COALESCE(folder_id, '00000000-…'::uuid)`, so a root note and a note inside a folder can share a name while
 * two root notes cannot.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '../client.js';
import { newId } from '../ids.js';
import { expectOne, firstOrNone } from '../rows.js';
import { type Note, notes } from '../schema.js';

/**
 * A sealed note: AES-256-GCM `ciphertext || tag` plus the 12-byte IV it needs, the key version that sealed
 * it, and the two plaintext statistics a listing shows without decrypting (PR-06 produces them when it seals).
 */
export interface SealedContent {
  readonly contentCipher: Uint8Array;
  readonly contentIv: Uint8Array;
  readonly keyVersion: number;
  /** Plaintext byte length. */
  readonly contentBytes: number;
  readonly wordCount: number;
}

export interface CreateNoteInput {
  readonly userId: string;
  /** `null`/omitted = the root. */
  readonly folderId?: string | null;
  /** WITHOUT the `.md` suffix (`stripMd()` in `contracts/names.ts`, PR-05, applied by PR-09). */
  readonly name: string;
  readonly content: SealedContent;
  /**
   * The row's id. PR-09 passes one it generated **before** it sealed the body, because the envelope's AAD is
   * `note:<uuid>` (plan §10): the id has to exist before the ciphertext does, and `sealNoteContent()` cannot be
   * handed an id a later insert would invent. Omitted, `newId()` still mints one — which is what PR-04's
   * fixture-path tests do, and the only thing they assert about the blob is that the exact bytes round-trip.
   */
  readonly id?: string;
}

export interface NoteKey {
  readonly userId: string;
  readonly id: string;
}

/** The columns a content write replaces — the same set on create and on update, so they cannot drift. */
function contentColumns(content: SealedContent) {
  return {
    contentCipher: content.contentCipher,
    contentIv: content.contentIv,
    keyVersion: content.keyVersion,
    contentBytes: content.contentBytes,
    wordCount: content.wordCount,
    contentUpdatedAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Creates a note with its first sealed version. A sibling already holding `name` raises `notes_unique_sib`
 * (SQLSTATE 23505), which is the answer to a name clash the caller checked and lost.
 */
export async function createNote(db: Db, input: CreateNoteInput): Promise<Note> {
  const inserted = await db
    .insert(notes)
    .values({
      id: input.id ?? newId(),
      userId: input.userId,
      folderId: input.folderId ?? null,
      name: input.name,
      ...contentColumns(input.content),
    })
    .returning();
  return expectOne(inserted, 'insert into notes');
}

/**
 * The note the caller owns, or nothing. `DbOrTx` because `services/note.service.ts` reads it inside the same
 * transaction that then writes the row, so the check and the write cannot be separated by another writer.
 */
export async function noteById(db: DbOrTx, key: NoteKey): Promise<Note | undefined> {
  const found = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, key.id), eq(notes.userId, key.userId)))
    .limit(1);
  return firstOrNone(found);
}

/**
 * The sibling lookup behind "that file name is taken": the same comparison `notes_unique_sib` makes, over the
 * folder the note is about to **land** in (see {@link patchNote}).
 */
export async function noteByFolderAndName(
  db: DbOrTx,
  input: { readonly userId: string; readonly folderId: string | null; readonly name: string },
): Promise<Note | undefined> {
  const found = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.userId, input.userId),
        input.folderId === null ? isNull(notes.folderId) : eq(notes.folderId, input.folderId),
        eq(notes.name, input.name),
      ),
    )
    .limit(1);
  return firstOrNone(found);
}

/** One folder's notes (`folderId: null` for the root), by name — the file-list order. */
export async function listNotes(
  db: Db,
  input: { readonly userId: string; readonly folderId: string | null },
): Promise<Note[]> {
  return db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.userId, input.userId),
        input.folderId === null ? isNull(notes.folderId) : eq(notes.folderId, input.folderId),
      ),
    )
    .orderBy(asc(notes.name));
}

/** Every note the user has, root included. */
export async function listAllNotes(db: Db, input: { readonly userId: string }): Promise<Note[]> {
  return db.select().from(notes).where(eq(notes.userId, input.userId)).orderBy(asc(notes.name));
}

/**
 * The "recent notes" list, driven by `notes_user_content_updated_idx`
 * (`user_id, content_updated_at desc`). `id` breaks ties so two writes in the same millisecond still return a
 * stable page.
 */
export async function recentNotes(
  db: Db,
  input: { readonly userId: string; readonly limit?: number },
): Promise<Note[]> {
  return db
    .select()
    .from(notes)
    .where(eq(notes.userId, input.userId))
    .orderBy(desc(notes.contentUpdatedAt), asc(notes.id))
    .limit(input.limit ?? 10);
}

/**
 * The one statement behind `PATCH /api/notes/:id`: rename, move, or **both at once**.
 *
 * Two separate updates were the bug this function exists to prevent. A rename followed by a move put the row in
 * the position *half* of the request described at the moment `notes_unique_sib` was consulted, so a
 * `PATCH {name, folderId}` naming a name that the note's **current** folder already held was refused with a
 * `409` for a clash in the folder the note was on its way out of — and a move that failed after the rename had
 * committed left exactly half of one request applied, with no way for the client to be told which half happened.
 * Writing both columns in one UPDATE means the index judges the row by the `(folder_id, name)` the caller asked
 * for, and there is no state in between for anyone to observe.
 *
 * Like every statement here it is scoped by `user_id`, so `undefined` means the note was not the caller's, and
 * it takes {@link DbOrTx} because `services/note.service.ts` runs it inside the transaction that checked the
 * destination. `version` is **not** touched: renaming and re-filing are not content edits (§8, DATA-MODEL §2),
 * and PR-10's optimistic lock must not be disturbed by something the user did in the sidebar.
 */
export async function patchNote(
  db: DbOrTx,
  input: NoteKey & { readonly name?: string | undefined; readonly folderId?: string | null | undefined },
): Promise<Note | undefined> {
  const updated = await db
    .update(notes)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      // Only an *absent* key means "leave it where it is"; `folderId: null` is the root, and it is a change.
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, input.id), eq(notes.userId, input.userId)))
    .returning();
  return firstOrNone(updated);
}

/**
 * The conditional content update, as a statement so its shape is assertable
 * (`notes.repo.int.test.ts` pins it): `UPDATE notes SET … WHERE id = $1 AND version = $2 AND user_id = $3
 * RETURNING *`.
 *
 * `version` is compared, never trusted, and is bumped by `version + 1` in the same statement, so two writers
 * starting from the same version cannot both win — the loser's `WHERE` matches zero rows. PR-10 renders that
 * zero-row case as a 409; the column itself only ever increases.
 */
export function contentUpdateStatement(
  db: Db,
  input: {
    readonly userId: string;
    readonly noteId: string;
    readonly baseVersion: number;
    readonly content: SealedContent;
  },
) {
  return db
    .update(notes)
    .set({
      ...contentColumns(input.content),
      version: sql`${notes.version} + 1`,
    })
    .where(
      and(eq(notes.id, input.noteId), eq(notes.version, input.baseVersion), eq(notes.userId, input.userId)),
    )
    .returning();
}

/**
 * Writes a new sealed version of a note, but only if the caller's `baseVersion` is still current.
 *
 * @returns the updated row, or `undefined` when nothing matched — a stale `baseVersion` (409 in PR-10), a
 *   note that does not exist, or one that belongs to someone else. All three are "your write did not
 *   happen"; the difference is not this layer's to invent.
 */
export async function writeNoteContent(
  db: Db,
  input: {
    readonly userId: string;
    readonly noteId: string;
    readonly baseVersion: number;
    readonly content: SealedContent;
  },
): Promise<Note | undefined> {
  return firstOrNone(await contentUpdateStatement(db, input));
}

/** Deletes one note. `false` means it was not the caller's to delete. */
export async function deleteNote(db: Db, key: NoteKey): Promise<boolean> {
  const deleted = await db
    .delete(notes)
    .where(and(eq(notes.id, key.id), eq(notes.userId, key.userId)))
    .returning({ id: notes.id });
  return deleted.length > 0;
}

/**
 * The names one folder already holds (`folderId: null` for the root).
 *
 * PR-09's service asks this **only for a generated name**, so `uniquify()` can pick `plan-2` instead of losing
 * the insert: a client-sent name must clash rather than be renamed behind the caller's back, so this list is
 * never consulted for one. Names only, deliberately — a folder listing for the same question would drag every
 * note body in the folder through the driver as ciphertext nobody reads.
 */
export async function noteNamesInFolder(
  db: Db,
  input: { readonly userId: string; readonly folderId: string | null },
): Promise<string[]> {
  const found = await db
    .select({ name: notes.name })
    .from(notes)
    .where(
      and(
        eq(notes.userId, input.userId),
        input.folderId === null ? isNull(notes.folderId) : eq(notes.folderId, input.folderId),
      ),
    );
  return found.map((row) => row.name);
}

/**
 * How many notes sit **directly** in one folder (`folderId: null` for the root), the second half of PR-09's
 * "is this folder empty?" test — a folder holding only notes is not empty just because it has no child folders.
 */
export async function countNotesInFolder(
  db: Db,
  input: { readonly userId: string; readonly folderId: string | null },
): Promise<number> {
  const found = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.userId, input.userId),
        input.folderId === null ? isNull(notes.folderId) : eq(notes.folderId, input.folderId),
      ),
    );
  return found.length;
}

/**
 * Every note the user has, for `GET /api/tree`, in the byte order the endpoint promises.
 *
 * Notes need no recursion — a note has one `folder_id` and no children — so the tree is this one flat select
 * beside `folders.repo.ts`'s one recursive CTE, and neither is per-folder: no listing in this file is an N+1.
 * `collate "C"` matches the folder half so the two lists the client joins are ordered the same way on every
 * cluster (§4 #12).
 */
export async function listNotesForTree(db: Db, input: { readonly userId: string }): Promise<Note[]> {
  return db
    .select()
    .from(notes)
    .where(eq(notes.userId, input.userId))
    .orderBy(sql`${notes.name} collate "C"`, asc(notes.id));
}
