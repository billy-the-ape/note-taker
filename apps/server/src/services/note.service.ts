/**
 * The note service: create, read, rename/move, delete (docs/plans/mvp/MVP-09.md §5.5–§5.6, plan §9.2 #16–#20).
 *
 * Three things about this file are the design, not incidental:
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
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { folderById } from '../db/repositories/folders.repo.js';
import {
  createNote,
  deleteNote,
  moveNote,
  noteByFolderAndName,
  noteById,
  noteNamesInFolder,
  renameNote,
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
  async function assertFolderIsMine(userId: string, folderId: string | null): Promise<void> {
    if (folderId === null) return;
    if ((await folderById(db, { userId, id: folderId })) === undefined) throw new NotFoundError('folder');
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
   * The name for a note the client *did* name: strip the display extension, then clash.
   *
   * Not uniquified, deliberately — `plan.md` next to an existing `plan` is answered with `CONFLICT` and the
   * winner's id rather than a stored `plan-2` the user never typed. `exceptId` is the note being renamed, which
   * may keep its own name.
   */
  async function chosenName(
    input: { readonly userId: string; readonly folderId: string | null; readonly name: string },
    exceptId?: string,
  ): Promise<string> {
    const stored = storedNoteName(input.name);
    const clash = await noteByFolderAndName(db, { ...input, name: stored });
    if (clash !== undefined && clash.id !== exceptId) throw nameClash(clash.id, 'note');
    return stored;
  }

  /** The same re-read `folder.service.ts` does: the index says "someone won", the client needs the winner's id. */
  async function lostNameRace(userId: string, folderId: string | null, name: string): Promise<ConflictError> {
    const clash = await noteByFolderAndName(db, { userId, folderId, name });
    return clash === undefined
      ? new ConflictError('that name is already used in this folder')
      : nameClash(clash.id, 'note');
  }

  return {
    async create({ userId, name, folderId = null, content }): Promise<NoteWithContent> {
      await assertFolderIsMine(userId, folderId);

      // The contract's schema already refuses an oversized body, so this is the transport net for a caller that
      // skipped the schema (a future internal caller): refuse before a key is used, not after storing a blob
      // the API says is illegal.
      const plaintext = content ?? '';
      if (utf8ByteLength(plaintext) > NOTE_CONTENT_MAX_BYTES) {
        throw new PayloadTooLargeError(NOTE_CONTENT_MAX_BYTES);
      }

      const storedName =
        name === undefined
          ? await generatedName(userId, folderId)
          : await chosenName({ userId, folderId, name });

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
      const current = await noteById(db, { userId, id });
      if (current === undefined) throw new NotFoundError('note');

      const targetFolderId = folderId === undefined ? current.folderId : folderId;
      const moving = targetFolderId !== current.folderId;
      if (moving) await assertFolderIsMine(userId, targetFolderId);

      const storedName =
        name === undefined ? current.name : await chosenName({ userId, folderId: targetFolderId, name }, id);

      try {
        const renamed =
          name === undefined
            ? current
            : ((await renameNote(db, { userId, id, name: storedName })) ?? current);
        if (!moving) return toNoteNode(renamed);
        const moved = await moveNote(db, { userId, id, folderId: targetFolderId });
        // Neither write touches `version`: a rename or a move is not a content edit (§8's rule, DATA-MODEL §2).
        return toNoteNode(moved ?? renamed);
      } catch (error) {
        if (isUniqueViolation(error)) throw await lostNameRace(userId, targetFolderId, storedName);
        throw error;
      }
    },

    async remove({ userId, id }): Promise<void> {
      // The row *is* the ciphertext, so a delete cannot orphan a key the way "decrypt then delete" would.
      if (!(await deleteNote(db, { userId, id }))) throw new NotFoundError('note');
    },
  };
}
