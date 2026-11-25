/**
 * The folder repository — the only place `folders` is read or written (docs/plans/mvp/MVP-04.md §5).
 *
 * Three rules every function here keeps:
 *
 * * **`db` is a parameter.** The pool is injected, so a test can pass its own and the app keeps its own;
 *   nothing in `src/db` reaches for module state (see `db/client.ts`). PR-09 widened the mutating and
 *   lookup functions to {@link DbOrTx}: a folder create/move/delete runs inside one transaction and has to be
 *   able to join it, and `Db` still satisfies the wider type, so PR-04's call sites did not move.
 * * **Every statement is scoped by `user_id`.** The schema's foreign keys do not carry `user_id`, so scoping
 *   is the repository's job; a row that belongs to someone else reads as "not found", which the API renders
 *   as a 404 rather than leaking existence as a 403.
 * * **`parentId: null` means the root**, and the root is a real place: `folders_unique_sib` compares
 *   `COALESCE(parent_id, '00000000-…'::uuid)`, so two root folders with the same name collide while a root
 *   folder and a same-named child of some folder do not.
 *
 * PR-09 added the statements the cycle and depth rules of docs/plans/mvp/MVP-09.md §5 need, and the one lock
 * that makes them mean something (the cycle check is *here* now, in the service that calls these functions
 * inside the lock — a repository that checked without the lock would be a race that looks like a guard):
 *
 * * {@link takeFolderMoveLock} — `pg_advisory_xact_lock`, **one per user**, taken first inside the transaction.
 *   Row locks on the two affected folders are not enough: two moves can lock disjoint pairs, each ancestor walk
 *   passes against committed state, and a four-node cycle commits. With exactly one advisory lock per user the
 *   opposite-order acquisition that makes Postgres abort one side of an `A↔B` pair (`40P01`) cannot occur, and
 *   the loser of the race waits and then reads the committed state.
 * * {@link folderDepth} — the **upward** walk: how deep is the destination.
 * * {@link folderSubtreeHeight} — the **downward** walk: how much does a move carry. The upward walk alone
 *   would pass a whole deep subtree re-parented under a shallow root and drop its tail below the guard.
 * * {@link listFolderTree} — `GET /api/tree` as one recursive CTE that also walks the breadcrumb path.
 *
 * Every recursive statement here carries the same bound, {@link TREE_WALK_GUARD}: a runaway belt against
 * corrupted `parent_id` data and never a silent truncation, because the service refuses any write that would
 * put a folder below depth 99 (§5.1–§5.2).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '../client.js';
import { newId } from '../ids.js';
import { expectOne, firstOrNone, rawRows, rawTextArray, rawTimestamp } from '../rows.js';
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

/**
 * The runaway guard of every recursive statement in this file: 100 levels, one more than the deepest legal
 * folder (the root is depth 0 and legal depths are 0…99), so a walk can only reach it on data the API refused
 * to create. `folder.service.ts` enforces the cap as an error before a write ever needs this bound.
 */
export const TREE_WALK_GUARD = 100;

/**
 * The namespace half of the folder-tree advisory lock. `hashtext` returns `integer`, which is what the
 * two-argument form of `pg_advisory_xact_lock` takes, and naming the operation keeps this application's tree
 * locks apart from any other hash-keyed lock in the same database.
 */
const FOLDER_MOVE_LOCK_NAMESPACE = sql`hashtext('folder_move')`;

/** One user's whole tree: the row, plus the two facts the recursive walk computed beside it. */
export interface FolderTreeRow extends Folder {
  /** Distance from the root: 0 for a root folder, at most 99 for the deepest legal one. */
  readonly depth: number;
  /** Its name and every ancestor's, root first — the breadcrumb PR-12's client renders. */
  readonly path: readonly string[];
}

/**
 * Takes the per-user folder lock (docs/plans/mvp/MVP-09.md §5.3).
 *
 * Call it **first** inside the transaction, before any walk or write, and only inside a transaction: it is an
 * *xact* lock, so it releases at commit/rollback, and called outside one it would release immediately and guard
 * nothing. The key is the **user id** — the one fact two moves in the same tree can never disagree about, which
 * is what makes the pair of disjoint row-lock pairs of §5.3 impossible.
 */
export async function takeFolderMoveLock(db: DbOrTx, userId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(${FOLDER_MOVE_LOCK_NAMESPACE}, hashtext(${userId}::text))`,
  );
}

/** Creates a folder. A sibling already holding `name` raises `folders_unique_sib` (SQLSTATE 23505). */
export async function createFolder(db: DbOrTx, input: CreateFolderInput): Promise<Folder> {
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
export async function folderById(db: DbOrTx, key: FolderKey): Promise<Folder | undefined> {
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
  db: DbOrTx,
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

/**
 * The one statement behind `PATCH /api/folders/:id`: rename, move, or **both at once**.
 *
 * The reasoning is `patchNote`'s, and it applies here for the same reason: a sibling clash is decided by
 * `(user_id, parent_id, name)`, so a rename that runs while the folder still sits under its **current** parent
 * is judged against the wrong parent. `PATCH {name, parentId}` naming a name one of the source's other children
 * already held was refused for a clash the destination did not have — a legal request answered `409`. Writing
 * both columns in one UPDATE is the smallest statement in which the row is in the place the caller asked for at
 * the moment the index looks.
 *
 * No cycle check here, on purpose: it belongs with PR-09's per-user advisory lock, and a check without that lock
 * would be a race that looks like a guard. What the database does guarantee is that a move never produces two
 * siblings with one name — which is exactly what `parentId` and `name` together have to be judged by.
 */
export async function patchFolder(
  db: DbOrTx,
  input: FolderKey & { readonly name?: string | undefined; readonly parentId?: string | null | undefined },
): Promise<Folder | undefined> {
  const updated = await db
    .update(folders)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      // Only an absent key means "leave it where it is"; `parentId: null` is the root, and it is a change.
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      updatedAt: new Date(),
    })
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
export async function deleteFolder(db: DbOrTx, key: FolderKey): Promise<boolean> {
  const deleted = await db
    .delete(folders)
    .where(and(eq(folders.id, key.id), eq(folders.userId, key.userId)))
    .returning({ id: folders.id });
  return deleted.length > 0;
}

/**
 * The direct child **folders** of one folder (root when `parentId` is `null`), for PR-09's delete confirmation
 * count. Paired with `notes.repo.ts`'s `countNotesInFolder`, because a folder that holds only notes is not
 * empty either.
 *
 * Direct children are the whole question: a descendant two levels down implies a child one level down, so "no
 * child folders and no notes here" and "nothing below it" are the same test at this size.
 */
export async function countChildren(
  db: DbOrTx,
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
  db: DbOrTx,
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
/**
 * One user's whole folder tree in **one** recursive CTE, each row carrying its depth and its breadcrumb path.
 *
 * The anchor is the set of the user's **root** folders, so `depth` and `path` fall out of the walk instead of a
 * second pass over the rows, and `parent.depth < ${TREE_WALK_GUARD}` is the bound §5.1 promises. `path` is the
 * §5.1 breadcrumb, built by concatenation on the way down: a recursive step only has the parent's path to hand,
 * and `array_agg` cannot see the ancestor chain from inside the recursive term. It is metadata for the walk and
 * not a wire field — `folderNodeSchema` has no path, and PR-12 rebuilds the nesting from `parentId` — but it is
 * asserted in `folders.repo.int.test.ts`, because a column nobody reads is a column nobody notices when it comes
 * back empty.
 *
 * Ordered by `name collate "C"` — byte order — so the answer is the same on a `C` and an `en_US.utf8` cluster
 * and no client has to sort twice to get what the server promised (§4 #12). The result is deliberately *flat*:
 * `folderNodeSchema` is a flat object with a `parentId`, so assembling `children` arrays here would be a
 * contract change PR-09 is not allowed to make.
 *
 * **Why the timestamps are cast, which is the whole point of this statement's shape.** A raw
 * `db.execute(sql`…`)` carries no column metadata, so no layer between Postgres and this function knows
 * `created_at` was ever a timestamp: PR-09's first CI run wrote `row.created_at as Date`, `toFolderNode` called
 * `.toISOString()` on the text that came back, and every `GET /api/tree` answered `500`. Asking for
 * `epoch … ::bigint` gives the value one unambiguous JS reading instead of hoping the driver guessed right, and
 * {@link rawTimestamp} still tolerates the shapes it might arrive in anyway. The `floor` is not decoration:
 * `numeric::bigint` **rounds**, while a JavaScript date parse of the microsecond text Postgres writes keeps the
 * millisecond and drops the rest, so without it the same instant could come back one millisecond apart from the
 * row that was inserted — the difference `folders.repo.int.test.ts` refuses to allow. The breadcrumb stays a
 * plain `text[]` — arrays in a recursive CTE are boring and proven, and {@link rawTextArray} reads the literal
 * Postgres writes — so the only new thing in this statement is a cast, not a type experiment.
 */
export async function listFolderTree(db: Db, input: { readonly userId: string }): Promise<FolderTreeRow[]> {
  const result = await db.execute(sql`
    with recursive tree as (
        select f.id,
               f.user_id,
               f.parent_id,
               f.name,
               floor(extract(epoch from f.created_at) * 1000)::bigint as created_at,
               floor(extract(epoch from f.updated_at) * 1000)::bigint as updated_at,
               0                      as depth,
               array [f.name]::text[] as path
          from folders f
         where f.user_id = ${input.userId}
           and f.parent_id is null
        union all
        select child.id,
               child.user_id,
               child.parent_id,
               child.name,
               floor(extract(epoch from child.created_at) * 1000)::bigint,
               floor(extract(epoch from child.updated_at) * 1000)::bigint,
               parent.depth + 1,
               parent.path || child.name
          from folders child
          join tree parent on child.parent_id = parent.id
         where parent.depth < ${TREE_WALK_GUARD}
      )
    select id, user_id, parent_id, name, created_at, updated_at, depth, path
      from tree
     order by name collate "C", id`);

  return rawRows<Record<string, unknown>>(result).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    name: String(row.name),
    createdAt: rawTimestamp(row.created_at),
    updatedAt: rawTimestamp(row.updated_at),
    depth: Number(row.depth),
    path: rawTextArray(row.path),
  }));
}

/**
 * How deep `id` sits in the tree: **0 for a root folder**, one more per ancestor (§5.2, the upward walk).
 *
 * `undefined` means the row is not the caller's — the service answers 404 rather than treating a missing depth
 * as `0` and quietly writing at the root. The walk is bounded by {@link TREE_WALK_GUARD}.
 *
 * There is no stored depth column to read: `folders` has four, and a materialised depth would be a second
 * truth for a move to get wrong.
 */
export async function folderDepth(
  db: DbOrTx,
  input: { readonly userId: string; readonly id: string },
): Promise<number | undefined> {
  const result = await db.execute(sql`
    with recursive ancestors as (
        select self.id, self.parent_id, 0 as depth
          from folders self
         where self.user_id = ${input.userId}
           and self.id = ${input.id}
        union all
        select parent.id, parent.parent_id, below.depth + 1
          from folders parent
          join ancestors below on parent.id = below.parent_id
         where below.depth < ${TREE_WALK_GUARD}
      )
    select max(depth) as depth from ancestors`);

  const [row] = rawRows<{ readonly depth: unknown }>(result);
  if (row === undefined || row.depth === null || row.depth === undefined) return undefined;
  return Number(row.depth);
}

/**
 * How far `id`'s subtree reaches **below** it: 0 for a leaf, 1 for one level of children (§5.2, the downward
 * walk, and the move cap's second half).
 *
 * `depth(newParent) + 1 + height(moved subtree) <= 99` is the whole rule for a move. Without the height,
 * re-parenting a subtree that already reaches depth 99 under a fresh root would pass the destination check and
 * strand its tail below the bound every walk here obeys — the tree would still *contain* every row, but
 * `listFolderTree` would stop returning them, which is the failure mode §4 #14 names.
 */
export async function folderSubtreeHeight(
  db: DbOrTx,
  input: { readonly userId: string; readonly id: string },
): Promise<number> {
  const result = await db.execute(sql`
    with recursive subtree as (
        select self.id, 0 as height
          from folders self
         where self.user_id = ${input.userId}
           and self.id = ${input.id}
        union all
        select child.id, above.height + 1
          from folders child
          join subtree above on child.parent_id = above.id
         where above.height < ${TREE_WALK_GUARD}
      )
    select max(height) as height from subtree`);

  const [row] = rawRows<{ readonly height: unknown }>(result);
  if (row === undefined || row.height === null || row.height === undefined) return 0;
  return Number(row.height);
}
