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

import type { Db } from '../client.js';
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

/** Creates a note with its first sealed version. A sibling already holding `name` raises 23505. */
export async function createNote(db: Db, input: CreateNoteInput): Promise<Note> {
  const inserted = await db
    .insert(notes)
    .values({
      id: newId(),
      userId: input.userId,
      folderId: input.folderId ?? null,
      name: input.name,
      ...contentColumns(input.content),
    })
    .returning();
  return expectOne(inserted, 'insert into notes');
}

export async function noteById(db: Db, key: NoteKey): Promise<Note | undefined> {
  const found = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, key.id), eq(notes.userId, key.userId)))
    .limit(1);
  return firstOrNone(found);
}

/** The sibling lookup behind "that file name is taken": the same comparison `notes_unique_sib` makes. */
export async function noteByFolderAndName(
  db: Db,
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

/** Renames a note; `undefined` means it was not the caller's to rename. */
export async function renameNote(
  db: Db,
  input: NoteKey & { readonly name: string },
): Promise<Note | undefined> {
  const updated = await db
    .update(notes)
    .set({ name: input.name, updatedAt: new Date() })
    .where(and(eq(notes.id, input.id), eq(notes.userId, input.userId)))
    .returning();
  return firstOrNone(updated);
}

/** Moves a note between folders (`folderId: null` = the root). */
export async function moveNote(
  db: Db,
  input: NoteKey & { readonly folderId: string | null },
): Promise<Note | undefined> {
  const updated = await db
    .update(notes)
    .set({ folderId: input.folderId, updatedAt: new Date() })
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
