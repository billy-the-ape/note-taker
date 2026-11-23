/**
 * The folder service: create, rename/move, delete (docs/plans/mvp/MVP-09.md §5.1–§5.5, plan §9.2 #13–#15).
 *
 * Everything the routes need to be right about lives here, in this order, inside **one transaction** that took
 * {@link takeFolderMoveLock} **first**:
 *
 * 1. scope-load the caller's folder (a row that is not theirs is `NOT_FOUND`, never `FORBIDDEN`);
 * 2. scope-load the destination parent the same way, which is what turns "move my folder into yours" into 404;
 * 3. refuse a cycle (§5.4) — `parentId` may not be the folder itself or anything below it;
 * 4. refuse the depth cap (§5.2) — the destination's depth **plus the height of the subtree being carried**;
 * 5. refuse a sibling clash by looking the sibling up first and reporting `error.data.id`, and let
 *    `folders_unique_sib` catch the race the check cannot see (§5.5);
 * 6. write.
 *
 * Why the lock and the transaction belong to the same statement: §5.3's two-tab race has both members
 * *committed* before either is checked, so no isolation level helps and a retry loop would only re-derive the
 * same cycle from a tree that has grown one. One `pg_advisory_xact_lock` per user serialises the two
 * transactions, the loser then reads the committed tree, and the check after it is worth something.
 *
 * The cap is arithmetic on two walks rather than a rule restated in prose: `FOLDER_MAX_DEPTH` and
 * `fitsWithinFolderDepth()` come from `@note-taker/contracts`, so the message, the check and the tree the UI
 * walks agree on one number.
 */
import { FOLDER_MAX_DEPTH, type FolderNode, fitsWithinFolderDepth } from '@note-taker/contracts';

import type { Db, DbOrTx } from '../db/client.js';
import { isUniqueViolation } from '../db/pg-error.js';
import {
  countChildren,
  createFolder,
  deleteFolder,
  folderById,
  folderByParentAndName,
  folderDepth,
  folderSubtreeHeight,
  isDescendantOrSelf,
  moveFolder,
  renameFolder,
  takeFolderMoveLock,
} from '../db/repositories/folders.repo.js';
import { countNotesInFolder } from '../db/repositories/notes.repo.js';
import type { Folder } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { nameClash } from '../domain/name.js';

export interface FolderService {
  /** `POST /api/folders`: a new child of `parentId`, or of the root when it is `null`/omitted. */
  readonly create: (input: CreateFolder) => Promise<FolderNode>;
  /** `PATCH /api/folders/:id`: rename and/or move; the schema already refuses a body with neither. */
  readonly patch: (input: PatchFolder) => Promise<FolderNode>;
  /**
   * `DELETE /api/folders/:id`. Without `cascade`, a non-empty folder throws `ConflictError`; with it the whole
   * subtree goes (`on delete cascade` does the work, and a note's ciphertext travels with its row, so no key is
   * ever orphaned by a cascade).
   */
  readonly remove: (input: RemoveFolder) => Promise<void>;
}

export interface CreateFolder {
  readonly userId: string;
  readonly name: string;
  /**
   * `| undefined` because `createFolderSchema.parse(body)` may hand back a key that is present with no value,
   * which `exactOptionalPropertyTypes` otherwise reads as a different thing from an absent key. `null` and
   * absent both mean the root.
   */
  readonly parentId?: string | null | undefined;
}

export interface PatchFolder {
  readonly userId: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly parentId?: string | null | undefined;
}

export interface RemoveFolder {
  readonly userId: string;
  readonly id: string;
  readonly cascade: boolean;
}

/**
 * The DB row → the API row.
 *
 * `userId` is dropped because the contract's `folderSchema` has no such field — the caller *is* the user, and
 * echoing back an id the client cannot send would be a contract leak — and the timestamps become ISO strings so
 * the JSON the route serialises satisfies `isoDateTimeSchema`.
 */
export function toFolderNode(row: Folder): FolderNode {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The cap's error. §4 #13 requires the message to **name the cap**, so both numbers are in it: the depth the
 * write would have produced, and the limit that refused it.
 *
 * `VALIDATION` with a `parentId` field error, because that is the field the caller has to change — and not
 * `CONFLICT`, which would advise retrying something that can never succeed, nor `NOT_FOUND`, which would
 * describe a folder the request never asked about.
 */
function folderTooDeep(landedDepth: number): ValidationError {
  return new ValidationError(
    `a folder there would sit at depth ${landedDepth}, and the tree is capped at ${FOLDER_MAX_DEPTH + 1} levels (depths 0-${FOLDER_MAX_DEPTH})`,
    { details: [{ path: 'parentId', message: `may not nest a folder below depth ${FOLDER_MAX_DEPTH}` }] },
  );
}

/**
 * The sibling check, run **inside** the lock so the answer cannot change underneath it.
 *
 * `exceptId` is the row being renamed or moved: giving a folder its own name back, or arriving where it already
 * lives, is not a clash — without that exclusion every no-op rename would report a collision with itself.
 */
async function assertFolderNameFree(
  executor: DbOrTx,
  input: {
    readonly userId: string;
    readonly parentId: string | null;
    readonly name: string;
    readonly exceptId?: string;
  },
): Promise<void> {
  const clash = await folderByParentAndName(executor, input);
  if (clash !== undefined && clash.id !== input.exceptId) throw nameClash(clash.id, 'folder');
}

/**
 * Re-reads the sibling an insert lost the race with, so the `409` can still carry `data.id`.
 *
 * Reading rather than guessing matters: the index only says "someone got there first", and the client's whole
 * recovery — adopt the row that exists instead of creating a second one — needs that row's id.
 */
async function lostNameRace(
  executor: DbOrTx,
  input: { readonly userId: string; readonly parentId: string | null; readonly name: string },
): Promise<ConflictError> {
  const clash = await folderByParentAndName(executor, input);
  // The other row can vanish between the failed insert and this read (its own delete won). The status code is
  // then the same, and a `409` with no id is still the truth: the state was not what the write assumed.
  return clash === undefined
    ? new ConflictError('that name is already used in this folder')
    : nameClash(clash.id, 'folder');
}

/** Builds the service over one pool; `buildApp()` registers one per process. */
export function createFolderService(options: { readonly db: Db }): FolderService {
  const { db } = options;

  return {
    async create({ userId, name, parentId = null }): Promise<FolderNode> {
      const created = await db.transaction(async (tx) => {
        await takeFolderMoveLock(tx, userId);

        // A create cannot produce a cycle, so only the depth rule applies — and it needs the destination's
        // depth and nothing else, because a brand-new folder carries no subtree.
        if (parentId !== null) {
          const parent = await folderById(tx, { userId, id: parentId });
          if (parent === undefined) throw new NotFoundError('folder');
          const parentDepth = (await folderDepth(tx, { userId, id: parentId })) ?? 0;
          // `fitsWithinFolderDepth` is the contract's formula and its precondition is a real parent depth; a
          // folder at the root is not expressible in it (there is no parent), and lands at depth 0, which can
          // never overflow the cap.
          if (!fitsWithinFolderDepth(parentDepth, 0)) throw folderTooDeep(parentDepth + 1);
        }

        await assertFolderNameFree(tx, { userId, parentId, name });
        try {
          return await createFolder(tx, { userId, parentId, name });
        } catch (error) {
          // The check above is not a substitute for the index: two concurrent creates in the same folder both
          // see the name free, and one of them has to be told so rather than getting an opaque 500.
          if (isUniqueViolation(error)) throw await lostNameRace(tx, { userId, parentId, name });
          throw error;
        }
      });
      return toFolderNode(created);
    },

    async patch({ userId, id, name, parentId }): Promise<FolderNode> {
      const updated = await db.transaction(async (tx) => {
        await takeFolderMoveLock(tx, userId);

        const current = await folderById(tx, { userId, id });
        if (current === undefined) throw new NotFoundError('folder');

        const targetParentId = parentId === undefined ? current.parentId : parentId;
        const moving = targetParentId !== current.parentId;

        if (moving) {
          // "Is that my folder?" is answered before "would that be a cycle?", so somebody else's id stays a 404
          // instead of becoming a fact about their tree. (`isDescendantOrSelf` is user-scoped too, so it can
          // only ever say "no" about a foreign target — but the 404 must not depend on that.)
          if (targetParentId !== null) {
            const target = await folderById(tx, { userId, id: targetParentId });
            if (target === undefined) throw new NotFoundError('folder');
            // `isDescendantOrSelf` also answers `true` for `targetId === id`, i.e. "into itself", which is the
            // smallest cycle there is and needs no special case here.
            if (await isDescendantOrSelf(tx, { userId, id, targetId: targetParentId })) {
              throw new ConflictError('a folder cannot be moved inside itself');
            }
          }

          // §5.2: the destination's depth *and* the height of what is being carried. The upward walk alone
          // would let a subtree that already reaches depth 99 be re-parented under a shallow root.
          const parentDepth =
            targetParentId === null ? -1 : ((await folderDepth(tx, { userId, id: targetParentId })) ?? 0);
          const height = await folderSubtreeHeight(tx, { userId, id });
          if (parentDepth >= 0 && !fitsWithinFolderDepth(parentDepth, height)) {
            throw folderTooDeep(parentDepth + 1 + height);
          }
        }

        const nextName = name ?? current.name;
        if (name !== undefined || moving) {
          await assertFolderNameFree(tx, { userId, parentId: targetParentId, name: nextName, exceptId: id });
        }

        try {
          const renamed =
            name === undefined ? current : ((await renameFolder(tx, { userId, id, name })) ?? current);
          if (!moving) return renamed;
          return (await moveFolder(tx, { userId, id, parentId: targetParentId })) ?? renamed;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw await lostNameRace(tx, { userId, parentId: targetParentId, name: nextName });
          }
          throw error;
        }
      });
      return toFolderNode(updated);
    },

    async remove({ userId, id, cascade }): Promise<void> {
      await db.transaction(async (tx) => {
        await takeFolderMoveLock(tx, userId);

        const current = await folderById(tx, { userId, id });
        if (current === undefined) throw new NotFoundError('folder');

        if (!cascade) {
          const childFolders = await countChildren(tx, { userId, parentId: id });
          const childNotes = await countNotesInFolder(tx, { userId, folderId: id });
          if (childFolders + childNotes > 0) {
            // The state is not what the request assumed, which is `CONFLICT`'s meaning here too. The counts are
            // in the message rather than `data` because `conflictErrorDataSchema` pins `data` to `{id}` (§9.1),
            // and the UI's confirmation dialog counts the same rows from the tree it already has.
            throw new ConflictError(
              `folder is not empty (${childFolders} folder(s) and ${childNotes} note(s) inside); delete with ?cascade=true`,
            );
          }
        }

        if (!(await deleteFolder(tx, { userId, id }))) throw new NotFoundError('folder');
      });
    },
  };
}
