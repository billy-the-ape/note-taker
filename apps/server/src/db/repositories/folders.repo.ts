/**
 * The folder repository — the only place `folders` is read or written (docs/plans/mvp/MVP-04.md §5).
 *
 * Three rules every function here keeps:
 *
 * * **`db` is a parameter.** The pool is injected, so a test can pass its own and the app keeps its own;
 *   nothing in `src/db` reaches for module state (see `db/client.ts`).
 * * **Every statement is scoped by `user_id`.** The schema's foreign keys do not carry `user_id`, so scoping
 *   is the repository's job; a row that belongs to someone else reads as "not found", which the API renders
 *   as a 404 rather than leaking existence as a 403.
 * * **`parentId: null` means the root**, and the root is a real place: `folders_unique_sib` compares
 *   `COALESCE(parent_id, '00000000-…'::uuid)`, so two root folders with the same name collide while a root
 *   folder and a same-named child of some folder do not.
 *
 * Deliberately **not** here: the cycle check for `moveFolder` (PR-09 owns it, because it needs the per-user
 * `pg_advisory_xact_lock('folder_move', user_id)` that makes the ancestor walk meaningful), and any parent
 * ownership check — a service must scope-load the target folder before passing it in, which is also what
 * turns "move my folder into yours" into a 404.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { expectOne, firstOrNone } from '../rows.js';
import { type Folder, folders } from '../schema.js';

export interface CreateFolderInput {
  readonly userId: string;
  readonly name: string;
  /** `null`/omitted = the root. */
  readonly parentId?: string | null;
}

export interface FolderKey {
  readonly userId: string;
  readonly id: string;
}

/** Creates a folder. A sibling already holding `name` raises `folders_unique_sib` (SQLSTATE 23505). */
export async function createFolder(db: Db, input: CreateFolderInput): Promise<Folder> {
  const inserted = await db
    .insert(folders)
    .values({
      id: newId(),
      userId: input.userId,
      parentId: input.parentId ?? null,
      name: input.name,
    })
    .returning();
  return expectOne(inserted, 'insert into folders');
}

/** The row, or `undefined` — which covers "does not exist" and "exists but belongs to someone else". */
export async function folderById(db: Db, key: FolderKey): Promise<Folder | undefined> {
  const found = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, key.id), eq(folders.userId, key.userId)))
    .limit(1);
  return firstOrNone(found);
}

/**
 * The sibling lookup that lets a service answer "is that name taken here?" before it inserts, i.e. the same
 * comparison `folders_unique_sib` makes — including the root, where the indexed value is the `COALESCE`
 * sentinel rather than `NULL`.
 */
export async function folderByParentAndName(
  db: Db,
  input: { readonly userId: string; readonly parentId: string | null; readonly name: string },
): Promise<Folder | undefined> {
  const found = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.userId, input.userId),
        input.parentId === null ? isNull(folders.parentId) : eq(folders.parentId, input.parentId),
        eq(folders.name, input.name),
      ),
    )
    .limit(1);
  return firstOrNone(found);
}

/** One level of one user's tree, `parentId: null` for the root row set. Ordered by name. */
export async function listFolders(
  db: Db,
  input: { readonly userId: string; readonly parentId: string | null },
): Promise<Folder[]> {
  return db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.userId, input.userId),
        input.parentId === null ? isNull(folders.parentId) : eq(folders.parentId, input.parentId),
      ),
    )
    .orderBy(asc(folders.name));
}

/** Every folder the user has, root included — what PR-09 assembles its tree out of. */
export async function listAllFolders(db: Db, input: { readonly userId: string }): Promise<Folder[]> {
  return db.select().from(folders).where(eq(folders.userId, input.userId)).orderBy(asc(folders.name));
}

/** Renames a folder; `undefined` means the row was not the caller's to rename. */
export async function renameFolder(
  db: Db,
  input: FolderKey & { readonly name: string },
): Promise<Folder | undefined> {
  const updated = await db
    .update(folders)
    .set({ name: input.name, updatedAt: new Date() })
    .where(and(eq(folders.id, input.id), eq(folders.userId, input.userId)))
    .returning();
  return firstOrNone(updated);
}

/**
 * Reparents a folder (`parentId: null` moves it to the root).
 *
 * No cycle check here, on purpose: it belongs with PR-09's per-user advisory lock, and a check without that
 * lock would be a race that looks like a guard. What the database does guarantee is that a move never
 * produces two siblings with one name.
 */
export async function moveFolder(
  db: Db,
  input: FolderKey & { readonly parentId: string | null },
): Promise<Folder | undefined> {
  const updated = await db
    .update(folders)
    .set({ parentId: input.parentId, updatedAt: new Date() })
    .where(and(eq(folders.id, input.id), eq(folders.userId, input.userId)))
    .returning();
  return firstOrNone(updated);
}

/**
 * Deletes one folder and — through `on delete cascade` — every folder and note below it.
 *
 * The API gates that behaviour behind `?cascade=true` (PR-09): this function is the honest version of what
 * the schema does, which is why there is no "delete anyway" flag here.
 */
export async function deleteFolder(db: Db, key: FolderKey): Promise<boolean> {
  const deleted = await db
    .delete(folders)
    .where(and(eq(folders.id, key.id), eq(folders.userId, key.userId)))
    .returning({ id: folders.id });
  return deleted.length > 0;
}

/** The direct children of one folder (root when `parentId` is `null`), for PR-09's delete confirmation count. */
export async function countChildren(
  db: Db,
  input: { readonly userId: string; readonly parentId: string | null },
): Promise<number> {
  const children = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.userId, input.userId),
        input.parentId === null ? isNull(folders.parentId) : eq(folders.parentId, input.parentId),
      ),
    );
  return children.length;
}

/**
 * `true` when reparenting `id` under `targetId` would create a cycle, i.e. when `targetId` is `id` itself or
 * sits anywhere below it.
 *
 * This is the read side of PR-09's cycle rule, and only that: PR-09 calls it **inside**
 * `pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))`, because a check like this run
 * outside the lock can be told "no" by a tree that changes shape before the move commits.
 *
 * It walks up from `targetId` — a folder's ancestors, bounded by the depth the UI builds — so no recursive
 * CTE is needed at this size, and `seen` makes a cycle that is already in the data answer `false` instead of
 * looping forever.
 */
export async function isDescendantOrSelf(
  db: Db,
  input: { readonly userId: string; readonly id: string; readonly targetId: string },
): Promise<boolean> {
  if (input.id === input.targetId) return true;

  const seen = new Set<string>([input.targetId]);
  let current = await folderById(db, { userId: input.userId, id: input.targetId });
  while (current !== undefined) {
    if (current.parentId === null) return false; // reached the root: `targetId` is not under `id`.
    if (current.parentId === input.id) return true;
    if (seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    current = await folderById(db, { userId: input.userId, id: current.parentId });
  }
  return false;
}
