/**
 * The note service: create, read, rename/move, delete (docs/plans/mvp/MVP-09.md §5.5–§5.6, plan §9.2 #16–#20).
 *
 * Four things about this file are the design, not incidental:
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
 *
 * The name rules themselves are the contract's; this file only calls {@link storedNoteName} once, on the way
 * in. `domain/name.ts` explains why stripping twice is a bug rather than a redundancy.
 */
import {
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
} from '../db/repositories/notes.repo.js';
import type { Note } from '../db/schema.js';
import { ConflictError, NotFoundError, PayloadTooLargeError } from '../domain/errors.js';
import { generatedNoteName, nameClash, storedNoteName, uniqueNoteName } from '../domain/name.js';

export interface NoteService {
  /** `POST /api/notes`: every field optional, which is what makes "new note" with an empty body legal. */
  readonly create: (input: CreateNote) => Promise<NoteWithContent>;
  /** `GET /api/notes/:id`: the metadata row plus the decrypted body. */
  readonly read: (input: NoteKey) => Promise<NoteWithContent>;
  /** `PATCH /api/notes/:id`: rename and/or move; returns metadata only, because nothing was decrypted. */
  readonly patch: (input: PatchNote) => Promise<NoteNode>;
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

      // One INSERT is atomic on its own, so a create needs no transaction — only the same two checks the patch
      // below makes, in the folder the row is being born in.
      const storedName = name === undefined ? await generatedName(userId, folderId) : storedNoteName(name);
      if (name !== undefined) await assertNoteNameFree(db, { userId, folderId, name: storedName });

      // The AAD is the row's id, so the id comes first, and the body is sealed against it before the insert.
      const id = newId();
      const sealed = sealNoteContent(plaintext, id, keyring);
      try {
        const row = await createNote(db, { id, userId, folderId, name: storedName, content: sealed });
        // The plaintext is already in hand; returning it is not a shortcut around decryption (that is what
        // `GET` proves) but the absence of a needless round-trip in the write path.
        return toNoteWithContent(row, plaintext);
      } catch (error) {
        if (isUniqueViolation(error)) throw await lostNameRace(userId, folderId, storedName);
        throw error;
      }
    },

    async read({ userId, id }): Promise<NoteWithContent> {
      const row = await noteById(db, { userId, id });
      if (row === undefined) throw new NotFoundError('note');
      // `EnvelopeError` deliberately propagates: mapping it is `error-handler.ts`'s job, and catching it here to
      // return an empty body would turn a server fault into a note that looks empty.
      return toNoteWithContent(row, openNoteContent(row, keyring));
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
