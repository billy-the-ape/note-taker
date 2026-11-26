/**
 * The note service: create, read, write content, rename/move, delete (docs/plans/mvp/MVP-09.md §5.5–§5.6,
 * docs/plans/mvp/MVP-10.md §4–§5, plan §9.2 #16–#20).
 *
 * Five things about this file are the design, not incidental:
 *
 * * **The id exists before the ciphertext does.** The envelope's AAD is `note:<uuid>` (plan §10), so
 *   `sealNoteContent()` needs the id the row will have; the service mints it with `newId()` and hands it to
 *   `createNote()`, rather than inserting an empty row and rewriting it. A note is never stored without a body:
 *   `content` absent seals the **empty string**, which is a real 12-byte IV and a 16-byte tag over zero bytes of
 *   plaintext — never an empty `content_cipher` (§5.6).
 * * **A generated name is uniquified; a chosen name is not.** `new-file-<msepoch>` collides when two notes are
 *   created in the same millisecond in one folder, so `uniquify()` runs on the *stored* base and can produce
 *   `new-file-123-2`. A name the client sent is different: silently renaming it to `plan-2` would tell the user
 *   their note had a different name than they typed, so it clashes instead — `CONFLICT` carrying the winner's
 *   id (§9.1).
 * * **`GET` decrypts, and does not cover for a failure.** `openNoteContent()` throwing
 *   `EnvelopeError` (tampered ciphertext, a key version the ring lost) is a server fault: the route answers
 *   `500 INTERNAL` and never `200` with `content: ''`, which would be indistinguishable from an empty note
 *   (§5.6, and §7's "the client must never see an empty body standing in for a failure").
 * * **A rename and a move are one statement.** `PATCH` may carry `name` and `folderId` together, and the
 *   sibling check below is against the folder the note will **land** in — which is only true if the write that
 *   moves it is the same write that renames it. See `patchNote` in `notes.repo.ts`: two updates were a `409` for
 *   a clash in the folder the note was leaving, and a half-applied request when the second one failed. The
 *   whole of {@link NoteService.patch} therefore runs in one transaction, and the loser-of-a-race re-read runs
 *   outside it, because Postgres rejects every statement after a unique violation until the rollback.
 * * **A content write is one conditional statement, and its zero rows are re-read before they are answered.**
 *   `putContent` never reads the row it is about to overwrite: it seals the body and writes
 *   `UPDATE … WHERE id AND user_id AND version = baseVersion RETURNING *` (plan Appendix A.2), so two tabs holding
 *   the same version cannot both win and nothing between the two halves of a write can be observed half-done.
 *   Zero rows back is *two* answers — a stale `baseVersion`, or a note that is not the caller's — and only a
 *   scoped re-read tells them apart: {@link staleWrite} below is what keeps #18 answering `404` for somebody
 *   else's id instead of `409`, and what hands the loser of the race the current server body to compare its own
 *   buffer against (§9.2 #18, PR-14's engine).
 *
 * The name rules themselves are the contract's; this file only calls {@link storedNoteName} once, on the way
 * in. `domain/name.ts` explains why stripping twice is a bug rather than a redundancy.
 */
import {
  MAX_NOTE_VERSION,
  NOTE_CONTENT_MAX_BYTES,
  type NoteNode,
  type NoteWithContent,
  utf8ByteLength,
} from '@note-taker/contracts';

import { openNoteContent, sealNoteContent } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keys.js';
import type { Db, DbOrTx } from '../db/client.js';
import { newId } from '../db/ids.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { folderById } from '../db/repositories/folders.repo.js';
import {
  createNote,
  deleteNote,
  noteByFolderAndName,
  noteById,
  noteNamesInFolder,
  patchNote,
  writeNoteContent,
} from '../db/repositories/notes.repo.js';
import type { Note } from '../db/schema.js';
import {
  ConflictError,
  type DomainError,
  NotFoundError,
  PayloadTooLargeError,
  VersionConflictError,
} from '../domain/errors.js';
import { generatedNoteName, nameClash, storedNoteName, uniqueNoteName } from '../domain/name.js';

export interface NoteService {
  /** `POST /api/notes`: every field optional, which is what makes "new note" with an empty body legal. */
  readonly create: (input: CreateNote) => Promise<NoteWithContent>;
  /** `GET /api/notes/:id`: the metadata row plus the decrypted body. */
  readonly read: (input: NoteKey) => Promise<NoteWithContent>;
  /** `PATCH /api/notes/:id`: rename and/or move; returns metadata only, because nothing was decrypted. */
  readonly patch: (input: PatchNote) => Promise<NoteNode>;
  /**
   * `PUT /api/notes/:id/content` (§9.2 #18): the whole new body, applied only if `baseVersion` is still current.
   * Returns the metadata row plus the new plaintext, with `version` moved by exactly one.
   */
  readonly putContent: (input: PutNoteContent) => Promise<NoteWithContent>;
  /** `DELETE /api/notes/:id`: the row and its ciphertext go together. */
  readonly remove: (input: NoteKey) => Promise<void>;
}

export interface NoteKey {
  readonly userId: string;
  readonly id: string;
}

export interface CreateNote {
  readonly userId: string;
  /** Absent means the server generates `new-file-<msepoch>`; a `.md` here is display-only and stripped. */
  readonly name?: string | undefined;
  /** `null`/absent is the root. */
  readonly folderId?: string | null;
  /** Absent means the empty string, sealed. */
  readonly content?: string | undefined;
}

/**
 * The input of {@link NoteService.putContent}: `PUT /api/notes/:id/content` (§9.2 #18).
 *
 * `content` is the **whole** new body. There is no partial write of a note body on purpose: a patch of an
 * encrypted body has nothing to patch against client-side and no conflict for a server that cannot read the
 * plaintext to merge (§7: the merge UI is PR-25, not this API).
 */
export interface PutNoteContent {
  readonly userId: string;
  readonly id: string;
  readonly content: string;
  /** The `notes.version` the caller read that body at. */
  readonly baseVersion: number;
  /**
   * Whether the request's `If-Match` admits `baseVersion`, as decided by `ifMatchAdmits()` in
   * `routes/notes.routes.ts`. That file owns the header's syntax (`W/"v7"`, `"v7"`, `*`, a comma list); this
   * layer owns what a violated precondition *means*, and it means the same answer a stale `baseVersion` gets.
   *
   * It arrives reduced to yes/no instead of as a version, because the two are not the same question: the
   * precondition is about the version the body names, and a header naming a different one has contradicted the
   * request carrying it whatever the row says. `true` — and absent, which is the same thing — leaves the
   * conditional write to decide everything by itself; `false` writes nothing and is answered by the same scoped
   * re-read the zero-row case gets.
   */
  readonly ifMatchAdmitsBase?: boolean | undefined;
}

/**
 * The input of {@link NoteService.patch}.
 *
 * The `| undefined` on the optional fields is what `exactOptionalPropertyTypes` asks for when the value arrives
 * from `renameMoveSchema.parse(...)`: a Zod `.optional()` may hand back a key that is *present with `undefined`*,
 * and the route spreads that body into this object, so "absent" and "explicitly undefined" have to be the same
 * case here rather than a type error in a file that did not invent either shape.
 */
export interface PatchNote {
  readonly userId: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly folderId?: string | null | undefined;
}

/** The DB row → the API's metadata row: no ciphertext, no key version, no `userId` (§9.2 #12). */
export function toNoteNode(row: Note): NoteNode {
  return {
    id: row.id,
    name: row.name,
    folderId: row.folderId,
    version: row.version,
    contentBytes: row.contentBytes,
    wordCount: row.wordCount,
    contentUpdatedAt: row.contentUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The metadata row plus the plaintext the caller just decrypted or sealed — the only shape with `content`. */
export function toNoteWithContent(row: Note, content: string): NoteWithContent {
  return { ...toNoteNode(row), content };
}

export interface NoteServiceOptions {
  readonly db: Db;
  readonly keyring: Keyring;
  /**
   * The clock the generated name is stamped from.
   *
   * Injectable because `new-file-<msepoch>` is worth asserting character for character, and a test cannot pin
   * `Date.now()` from outside — `note.service.int.test.ts` passes a fixed number rather than matching a pattern.
   */
  readonly now?: () => number;
}

/** Builds the service over one pool and one keyring; `buildApp()` registers one per process. */
/**
 * How many times a note with a **generated** name may pick a new one before its create gives up (the loop in
 * `create` below).
 *
 * Five is not a tuned number. Contention here is bounded by how many nameless creates land in one folder inside
 * the same millisecond, and every retry re-reads that folder, so the second attempt already sees the row that won
 * and `uniquify` moves to the next free suffix. What the bound is for is an exit: a future unique index nobody
 * thought about should fail a request, not spin in the write path forever.
 */
const GENERATED_NAME_ATTEMPTS = 5;

export function createNoteService(options: NoteServiceOptions): NoteService {
  const { db, keyring } = options;
  const now = options.now ?? Date.now;

  /**
   * A body-supplied `folderId` must be the caller's, **before** anything is written: that is what turns "put my
   * note in your folder" into a 404 instead of a foreign key violation, and it is the first line of defence the
   * `23503` mapping in `error-handler.ts` sits behind.
   */
  async function assertFolderIsMine(
    executor: DbOrTx,
    userId: string,
    folderId: string | null,
  ): Promise<void> {
    if (folderId === null) return;
    if ((await folderById(executor, { userId, id: folderId })) === undefined)
      throw new NotFoundError('folder');
  }

  /**
   * The name for a note the client did not name: the contract's `new-file-<msepoch>`, extension-stripped once,
   * then `uniquify`d against the destination (§5.5). Two creates in one millisecond in one folder are not rare
   * (a double-clicked "New note"), and this is the one place a name may be changed, because there is no name the
   * user typed to be contradicted.
   */
  async function generatedName(userId: string, folderId: string | null): Promise<string> {
    const base = generatedNoteName(now());
    const taken = await noteNamesInFolder(db, { userId, folderId });
    return uniqueNoteName(base, taken);
  }

  /**
   * The check a note the client *did* name has to pass.
   *
   * Not uniquified, deliberately — `plan.md` next to an existing `plan` is answered with `CONFLICT` and the
   * winner's id rather than a stored `plan-2` the user never typed (§5.5). `exceptId` is the note being renamed,
   * which may keep its own name.
   *
   * It takes the **executor**, not the pool, for one reason: on a move, the answer must come from the same
   * transaction as the write that lands the note. Asked outside, it describes a folder the note is only on its
   * way to, and that is how a legal `PATCH {name, folderId}` gets refused for a clash in the folder the note is
   * leaving.
   */
  async function assertNoteNameFree(
    executor: DbOrTx,
    input: {
      readonly userId: string;
      readonly folderId: string | null;
      readonly name: string;
      readonly exceptId?: string;
    },
  ): Promise<void> {
    const clash = await noteByFolderAndName(executor, input);
    if (clash !== undefined && clash.id !== input.exceptId) throw nameClash(clash.id, 'note');
  }

  /**
   * The same re-read `folder.service.ts` does: the index says "someone won", the client needs the winner's id.
   *
   * Always on the pool and never on the caller's transaction: after a unique violation Postgres answers every
   * further statement with `25P02` until that transaction rolls back, so this is only meaningful once it has.
   * The winner is committed by then — a write that fails on a unique index waits for the writer that got there
   * first, which is the same reason the row is findable here at all.
   */
  async function lostNameRace(userId: string, folderId: string | null, name: string): Promise<ConflictError> {
    const clash = await noteByFolderAndName(db, { userId, folderId, name });
    return clash === undefined
      ? new ConflictError('that name is already used in this folder')
      : nameClash(clash.id, 'note');
  }

  /**
   * The answer to "your content write did not happen", after the scoped re-read plan Appendix A.2 asks for.
   *
   * The conditional `UPDATE` filtered on `id` **and** `user_id`, so zero rows back means one of two things and
   * the statement cannot say which: the caller's `baseVersion` is stale, or the note is not the caller's (or is
   * gone). Re-reading scoped to the caller separates them, and it is the only thing standing between a client
   * probing random uuids and a `409` that would confirm a foreign row exists — #18 answers `404`, never `409`,
   * for an id it does not own (§5).
   *
   * The conflict half carries the **current server plaintext and version**, because that pair is what lets
   * PR-14's autosave engine tell its own committed-but-unacknowledged write from a real collision: the client
   * compares the returned body byte for byte with the snapshot it put on the wire (§9.2 #18). Producing it means
   * decrypting the row we just declined to overwrite, so an `EnvelopeError` can surface here too — and it is
   * mapped, not swallowed: `500 INTERNAL` beats a `409` quoting a body this process cannot read, which a client
   * would then treat as the server's honest current state and overwrite.
   *
   * Returns rather than throws, exactly like {@link lostNameRace} above: the caller is one `throw await` away
   * either way, and the two answers stay in one place.
   */
  async function staleWrite(userId: string, id: string): Promise<DomainError> {
    const current = await noteById(db, { userId, id });
    if (current === undefined) return new NotFoundError('note');
    return new VersionConflictError(openNoteContent(current, keyring), current.version);
  }

  return {
    async create({ userId, name, folderId = null, content }): Promise<NoteWithContent> {
      await assertFolderIsMine(db, userId, folderId);

      // The contract's schema already refuses an oversized body, so this is the transport net for a caller that
      // skipped the schema (a future internal caller): refuse before a key is used, not after storing a blob
      // the API says is illegal.
      const plaintext = content ?? '';
      if (utf8ByteLength(plaintext) > NOTE_CONTENT_MAX_BYTES) {
        throw new PayloadTooLargeError(NOTE_CONTENT_MAX_BYTES);
      }

      // The AAD is the row's id, so the id comes first, and the body is sealed against it before the insert. The
      // id is minted once even though a generated name may be chosen more than once below: the row does not exist
      // yet on any attempt, and the envelope is bound to that id, not to the name.
      const id = newId();
      const sealed = sealNoteContent(plaintext, id, keyring);

      if (name !== undefined) {
        const storedName = storedNoteName(name);
        // One INSERT is atomic on its own, so a create needs no transaction — only the same check the patch below
        // makes, in the folder the row is being born in.
        await assertNoteNameFree(db, { userId, folderId, name: storedName });
        try {
          const row = await createNote(db, { id, userId, folderId, name: storedName, content: sealed });
          return toNoteWithContent(row, plaintext);
        } catch (error) {
          // A name the client *typed* stays its name: `plan` beside an existing `plan` is `409` with the winner's
          // id, never a stored `plan-2` nobody asked for (§5.5). The race below is not this request's.
          if (isUniqueViolation(error)) throw await lostNameRace(userId, folderId, storedName);
          throw error;
        }
      }

      // A name the client did **not** type is the one name this server is allowed to change on its own (§5.5), so
      // losing this race is not the client's problem to receive.
      //
      // {@link generatedName} reads the folder's names and picks the next free suffix, and two nameless creates in
      // the same folder in the same millisecond — a double-clicked "New note", which a sequential test can only
      // ever simulate one at a time — both read the same "free". The loser's INSERT waits on `notes_unique_sib`
      // until the winner commits and then fails with `23505`. Answering that with `409 CONFLICT` would report a
      // clash on a name the client never sent and hand back the id of a note it never intended to open, which is
      // precisely what `docs/NAME-RULES.md` and `docs/API.md` promise does not happen. So re-read and try again:
      // every attempt is a fresh statement, so it sees the row that just won, and `uniquify` moves to the next
      // suffix. The bound exists only so that a pathological fan-out — or some future unique index nobody
      // anticipated — cannot spin here forever; the last attempt falls back to the old `409`, which at least names
      // a row that exists.
      //
      // `23505` is the only thing this can be: the other constraints on the insert are the primary key (a fresh
      // v7 UUID) and two foreign keys, and those are `23503`, which falls through untouched — including the case
      // of the folder being deleted underneath this create, which stays the `404` it has always been.
      for (let attempt = 1; ; attempt += 1) {
        const storedName = await generatedName(userId, folderId);
        try {
          const row = await createNote(db, { id, userId, folderId, name: storedName, content: sealed });
          // The plaintext is already in hand; returning it is not a shortcut around decryption (that is what
          // `GET` proves) but the absence of a needless round-trip in the write path.
          return toNoteWithContent(row, plaintext);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          if (attempt >= GENERATED_NAME_ATTEMPTS) throw await lostNameRace(userId, folderId, storedName);
        }
      }
    },

    async read({ userId, id }): Promise<NoteWithContent> {
      const row = await noteById(db, { userId, id });
      if (row === undefined) throw new NotFoundError('note');
      // `EnvelopeError` deliberately propagates: mapping it is `error-handler.ts`'s job, and catching it here to
      // return an empty body would turn a server fault into a note that looks empty.
      return toNoteWithContent(row, openNoteContent(row, keyring));
    },

    /**
     * §9.2 #18 — the versioned write, as one statement (docs/plans/mvp/MVP-10.md §4, plan Appendix A.2).
     *
     * Three orders in this method are the point, and none of them is decoration:
     *
     * 1. **The cap is checked before the key is used**, exactly as `create` does it. Fastify's `bodyLimit` is
     *    the door a request meets first (`MAX_NOTE_BYTES`, default 1 MiB → `413`), and the contract's own
     *    `contentUpdateSchema` refuses an over-cap `content` on the way in; this is the net under a caller that
     *    reached the service past both, and it has to come before the sealing because storing a body the API
     *    calls illegal is worse than spending a round of AES on it.
     * 2. **A precondition this request itself contradicts is settled before anything is written.** The
     *    conditional update can only speak for `baseVersion`; if the caller's `If-Match` named a different
     *    version then the write it asked for is the one the RFC forbids — "the method is applied only to a state
     *    the precondition matches" — so nothing is written and the scoped re-read gives the honest answer (§5).
     *    **A `baseVersion` the column cannot hold is settled the same way, for the same reason:** `notes.version`
     *    is an `int4`, so comparing `3_000_000_000` in the `WHERE` is not "zero rows" but Postgres `22003` (value
     *    out of range), which `mapError()` has no case for and would report as `500 INTERNAL` on the strength of a
     *    number the caller invented. `noteVersionSchema` refuses such a body on the wire (**PR-10** review); the
     *    check below is the net under a caller that reached the service past the schema, which is also where the
     *    cap in 1 lives.
     * 3. **Sealing comes after both, and the write is the only statement.** No read precedes the `UPDATE`: the
     *    version is *compared*, never trusted, and `version + 1` happens in the same statement as the new
     *    envelope, so two tabs that read the same version cannot both win and there is no intermediate state for
     *    a crash — or a `pg_cancel_backend` — to land in. The empty string is a legal body and still stores a
     *    12-byte IV and a 16-byte tag; `version` moves exactly once here and nowhere else (§5's rule, which is
     *    also why `patch` above refuses to touch it and why PR-06's rotation never bumps it).
     */
    async putContent({
      userId,
      id,
      content,
      baseVersion,
      ifMatchAdmitsBase,
    }: PutNoteContent): Promise<NoteWithContent> {
      if (utf8ByteLength(content) > NOTE_CONTENT_MAX_BYTES) {
        throw new PayloadTooLargeError(NOTE_CONTENT_MAX_BYTES);
      }
      if (ifMatchAdmitsBase === false) throw await staleWrite(userId, id);
      // A version outside the column cannot match any row, so it is the same fact as a stale one — and it must not
      // reach the statement, where comparing it is a `22003` rather than an empty result set. `MAX_NOTE_VERSION`
      // is the contract's own bound, the one `noteVersionSchema` applies to this field, so the wire and this net
      // cannot disagree about what the domain is.
      if (baseVersion < 1 || baseVersion > MAX_NOTE_VERSION) throw await staleWrite(userId, id);

      // The AAD is the row's id, so the body is sealed against the id it will be stored under — the same id the
      // write filters on, which is what makes a ciphertext copied from another note fail to authenticate.
      const sealed = sealNoteContent(content, id, keyring);
      const updated = await writeNoteContent(db, { userId, noteId: id, baseVersion, content: sealed });
      if (updated !== undefined) {
        // The row comes back whole from the `RETURNING`, so the new `version` needs no second query and cannot
        // describe a state that has since moved; the plaintext is already in hand, and returning it is the
        // absence of a needless decryption rather than a shortcut around one.
        return toNoteWithContent(updated, content);
      }
      throw await staleWrite(userId, id);
    },

    async patch({ userId, id, name, folderId }): Promise<NoteNode> {
      const storedName = name === undefined ? undefined : storedNoteName(name);
      // The `(folder, name)` the transaction is about to write. It exists because the loser of a name race has
      // to be answered *outside* that transaction — Postgres closes a transaction to further statements the
      // moment a statement violates an index — and out here neither half of the pair is knowable any more.
      // Assigned immediately before the write, which is the only statement that can violate anything.
      let attempted: { readonly folderId: string | null; readonly name: string } | undefined;

      let row: Note;
      try {
        row = await db.transaction(async (tx) => {
          // Load, check and write in one transaction, because the question being asked — "is `name` free in the
          // folder this note will be in?" — has no answer that survives contact with another writer unless the
          // folder is the one the write itself establishes. Renaming here while the row still sat in its source
          // folder was the bug: a `PATCH {name, folderId}` was refused for a clash it did not have, and a move
          // that then failed left the rename applied (§5.5, and `patchNote`).
          const current = await noteById(tx, { userId, id });
          if (current === undefined) throw new NotFoundError('note');

          const destination = folderId === undefined ? current.folderId : folderId;
          const moving = destination !== current.folderId;
          if (moving) await assertFolderIsMine(tx, userId, destination);

          const nextName = storedName ?? current.name;
          if (storedName !== undefined || moving) {
            // A move alone can collide too: the note keeps its name, and the folder it is going to may already
            // hold that name. Checking it here rather than letting the index answer means the 409 can carry the
            // winner's id, which is the whole recovery the client has.
            await assertNoteNameFree(tx, { userId, folderId: destination, name: nextName, exceptId: id });
          }

          attempted = { folderId: destination, name: nextName };
          const updated = await patchNote(tx, {
            userId,
            id,
            ...(storedName === undefined ? {} : { name: storedName }),
            // Only a real move goes in: an absent `folderId` means "leave it where it is", and a rename alone
            // must not rewrite the folder the note is already in.
            ...(moving ? { folderId: destination } : {}),
          });
          // Loaded two statements earlier in this transaction, so a miss is a concurrent delete, which is the
          // same answer the request would have received a moment before it started.
          if (updated === undefined) throw new NotFoundError('note');
          // `version` is untouched by this statement: a rename or a move is not a content edit (§8's rule,
          // DATA-MODEL §2), and PR-10's optimistic lock must not move because of something typed in a sidebar.
          return updated;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw attempted === undefined
            ? new ConflictError('that name is already used in this folder')
            : await lostNameRace(userId, attempted.folderId, attempted.name);
        }
        throw error;
      }

      return toNoteNode(row);
    },

    async remove({ userId, id }): Promise<void> {
      // The row *is* the ciphertext, so a delete cannot orphan a key the way "decrypt then delete" would.
      if (!(await deleteNote(db, { userId, id }))) throw new NotFoundError('note');
    },
  };
}
