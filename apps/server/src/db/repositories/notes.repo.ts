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
 *
 * PR-11 added the two statements behind `GET /api/search` ({@link searchNotesByMetadata},
 * {@link listRecentNotesForSearch}). They keep the rule above in the strictest form the feature allows: the
 * search still hands back the *opaque* triple and never a plaintext — decrypting it is `crypto/envelope.ts`
 * inside `services/search.service.ts`, and the `WHERE` clause that decides which bodies are even read is SQL
 * over the columns the schema keeps in the clear (names, folder paths, timestamps).
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '../client.js';
import { newId } from '../ids.js';
import { expectOne, firstOrNone, rawRows, rawTimestamp } from '../rows.js';
import { type Note, notes } from '../schema.js';
import { folderPathCte } from './folders.repo.js';

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

/**
 * One row of a search result set: the note, its folder's breadcrumb path, and — for the candidate window only —
 * the opaque envelope triple (PR-11, docs/plans/mvp/MVP-11.md §4).
 *
 * `folderPath` is the contract's `folderPath`: the folder's own name and every ancestor's, `/`-joined, root
 * first, and **empty for a note at the root**. It arrives as `array_to_string` rather than as a `text[]`
 * because that is the one shape the contract has a field for, and the joining happens in the same statement
 * that decided the row matched, so the string a client is shown and the string the server matched on cannot
 * be two different answers.
 */
export interface NoteSearchRow {
  readonly id: string;
  readonly name: string;
  readonly folderId: string | null;
  readonly folderPath: string;
  readonly contentUpdatedAt: Date;
}

/** A candidate for the in-process pass: the row, its path, and the envelope `crypto/envelope.ts` opens. */
export interface NoteSearchCandidate extends NoteSearchRow {
  readonly contentCipher: Uint8Array;
  readonly contentIv: Uint8Array;
  readonly keyVersion: number;
}

/**
 * The columns both search statements read, in the one spelling that makes `content_updated_at` a value a
 * JavaScript date parse can be sure of.
 *
 * The `floor(extract(epoch …) * 1000)::bigint` cast is `folders.repo.ts`'s `listFolderTree`, and for the same
 * reason: a raw
 * `db.execute` carries no column metadata, so a `timestamptz` would come back as whatever the driver felt like
 * writing. {@link rawTimestamp} then reads the epoch milliseconds back into a `Date` and would throw rather than
 * invent one — which matters here beyond the response shape, because `content_updated_at` *is* the search's
 * recency tiebreak (§4) and a silently-wrong date would reorder results rather than fail.
 */
const SEARCH_COLUMNS = sql`
      n.id,
      n.name,
      n.folder_id,
      coalesce(array_to_string(folder_paths.path, '/'), '') as folder_path,
      floor(extract(epoch from n.content_updated_at) * 1000)::bigint as content_updated_at`;

/** The five columns both search statements share, minus the envelope. */
function searchRowBase(row: Record<string, unknown>): NoteSearchRow {
  return {
    id: String(row.id),
    name: String(row.name),
    folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
    // A root note has no folder row to join, so its path arrives NULL: "empty" is the contract's answer, not a
    // string this file invented for it.
    folderPath: String(row.folder_path ?? ''),
    contentUpdatedAt: rawTimestamp(row.content_updated_at),
  };
}

/**
 * The character that makes a `%`, `_` or `\` in the caller's text mean itself: one backslash.
 *
 * It is **bound as a parameter** below rather than written into the SQL text, and that choice is the whole reason
 * this constant exists. A backslash inside a JS template literal is cooked by JavaScript before Postgres ever sees
 * it: this file used to write `escape '\'` and Postgres received `escape ''` — an empty escape character, which
 * *disables* escaping, so each backslash {@link likeContainsPattern} had added became a literal character of the
 * pattern, and a search for `100%` asked for a name containing a backslash instead (PR-11 review, inline
 * `r4721929072`). Even a cooked-correct `'\'` would leave the statement's behaviour depending on a second reader's
 * opinion of `standard_conforming_strings`. Interpolated, the fragment carries no backslash to cook or to re-quote,
 * and the `ESCAPE` clause and the pattern's escaping are literally the same value instead of two spellings that can
 * drift apart.
 */
const LIKE_ESCAPE_CHAR = '\\';

/** The `ESCAPE` clause of both `LIKE`s, its character bound as a parameter (see {@link LIKE_ESCAPE_CHAR}). */
const LIKE_ESCAPE = sql`escape ${LIKE_ESCAPE_CHAR}`;

/**
 * The `LIKE` pattern that means "the caller's text, as a substring, literally".
 *
 * Three characters have to survive translation. `%` and `_` are the wildcards, and a search box that typed
 * `100%` means the discount, not "everything" — which is exactly what an unescaped `%` would answer, for the
 * whole corpus, in the one branch that is guaranteed to see the whole corpus. `\` is the escape character, so a
 * backslash in the text has to escape itself or it would silently eat the character after it — and it is escaped
 * **first**, because the escapes added by the next two rules must not be escaped again.
 *
 * `[` and `]` need no rule of their own: they are wildcards in `SIMILAR TO`, not in `LIKE`.
 *
 * Escaping happens here rather than in the service because this file owns the meaning of the string it puts in
 * the `WHERE`: handing a caller's `%` to `LIKE` from the service would be a repository whose pattern means two
 * things depending on who built it.
 */
export function likeContainsPattern(term: string): string {
  const escaped = term
    .replaceAll(LIKE_ESCAPE_CHAR, LIKE_ESCAPE_CHAR + LIKE_ESCAPE_CHAR)
    .replaceAll('%', `${LIKE_ESCAPE_CHAR}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHAR}_`);
  return `%${escaped}%`;
}

/**
 * Every note whose **name**, or whose folder's **name**, matches the pattern — the branch that guarantees search
 * sees the whole corpus (PR-11 §4).
 *
 * Three properties the in-process pass cannot give and this one can:
 *
 * * it does not stop at the 500 most recent notes;
 * * it needs no key, so it answers while some note bodies in the install are unreadable;
 * * it is indexed-adjacent work at MVP size (the folder walk is per user and tiny; the note scan is the same
 *   sequential read `GET /api/tree` already pays).
 *
 * **It is accent-sensitive, and that asymmetry is documented rather than hidden.** `unaccent` is not installed —
 * PR-04's migration enables `pgcrypto` alone — and NFD accent folding is not expressible as a `LIKE` pattern, so
 * `cafe` finds a note named `café` only while that note is inside the other statement's window. Closing the gap
 * needs a folded generated column or `unaccent`: backlog PR-29, not this PR.
 *
 * The folder test is `exists (… unnest(path) …)`, i.e. **one segment of the path**, not the joined string: a
 * folder name can never contain `/` (`docs/NAME-RULES.md`'s forbidden characters), so a query that does contain
 * `/` should match nothing rather than every note under some folder.
 *
 * `lower(...) ilike …` is belt-and-braces (`ilike` alone would match, and the pattern is already lowercase), but
 * it is what the brief names and it makes the statement's collation dependence obvious rather than incidental.
 */
export async function searchNotesByMetadata(
  db: Db,
  input: { readonly userId: string; readonly pattern: string; readonly limit: number },
): Promise<NoteSearchRow[]> {
  const result = await db.execute(
    sql`${folderPathCte(input.userId)}
    select ${SEARCH_COLUMNS}
      from notes n
      left join folder_paths on folder_paths.id = n.folder_id
     where n.user_id = ${input.userId}
       and (
            lower(n.name) ilike ${input.pattern} ${LIKE_ESCAPE}
         or exists (
              select 1
                from unnest(folder_paths.path) as matched_segment(segment_name)
               where lower(matched_segment.segment_name) ilike ${input.pattern} ${LIKE_ESCAPE}
            )
         )
     order by n.content_updated_at desc, n.id
     limit ${input.limit}`,
  );
  return rawRows<Record<string, unknown>>(result).map(searchRowBase);
}

/**
 * The **candidate window**: up to `limit` of the caller's most recently updated notes, envelopes included, newest
 * first — the set the in-process pass decrypts and matches name, path and body against (PR-11 §4).
 *
 * It is `recentNotes`' ordering (`content_updated_at desc, id asc`, which is exactly
 * `notes_user_content_updated_idx`) with the breadcrumb path joined on, so the window the pass scores and the
 * recency tiebreak it falls back on come from the same statement. The `limit` is not a pagination knob: it *is*
 * the scan bound, and a caller that could raise it would be paying to decrypt a corpus-sized request, which is
 * the trade-off ADR-0002 accepted at MVP scale and backlog PR-29 exists to retire.
 *
 * Ordered, and ordered *stably*, because the pass it feeds can only rank what it is handed: `id` breaks a tie
 * between two writes in the same millisecond, so "the 501st most recent note is not searched" is a fact rather
 * than a race.
 */
export async function listRecentNotesForSearch(
  db: Db,
  input: { readonly userId: string; readonly limit: number },
): Promise<NoteSearchCandidate[]> {
  const result = await db.execute(
    sql`${folderPathCte(input.userId)}
    select ${SEARCH_COLUMNS},
           n.content_cipher,
           n.content_iv,
           n.key_version
      from notes n
      left join folder_paths on folder_paths.id = n.folder_id
     where n.user_id = ${input.userId}
     order by n.content_updated_at desc, n.id
     limit ${input.limit}`,
  );
  return rawRows<Record<string, unknown>>(result).map((row) => ({
    ...searchRowBase(row),
    // The triple stays a triple: this layer never decrypts, and `crypto/envelope.ts` accepts the three fields
    // structurally (`NoteEnvelope`), so the candidate row goes to it unchanged.
    contentCipher: row.content_cipher as Uint8Array,
    contentIv: row.content_iv as Uint8Array,
    keyVersion: Number(row.key_version),
  }));
}
