/**
 * Tree mutations: optimistic cache writes, rollback on failure (docs/plans/mvp/MVP-12.md §5, plan §11.2).
 *
 * The cache entry for `['tree', userId]` is the server's `TreeResponse` (see `tree.queries.ts`), so an
 * optimistic update is a pure function `TreeResponse → TreeResponse` — four of them, exported below
 * (`applyRename`, `applyMove`, `applyDelete`) because that is what makes them testable without React and
 * what makes the rollback trivially correct: the previous entry is kept and written back, not recomputed.
 *
 * **The order TanStack Query runs, and why this file depends on it:** `onMutate` snapshots the cache and
 * writes the optimistic value; the request goes out; on rejection `onError` restores the snapshot before the
 * error reaches the component, so a dialog that shows `mutation.error` is looking at a tree that has already
 * gone back to what the server believes. On *settle* — win or lose — `onSettled` invalidates the key, so the
 * optimistic value is never allowed to become the truth: it is a preview of a response that is on its way.
 *
 * **Folder creation is not optimistic, on purpose.** There is no id to draw a row with before the response
 * arrives (`newId()` is the server's, plan §8), and inventing a placeholder id would mean every later
 * mutation of that row racing a reconciliation. `201` plus a refetch is a few milliseconds; a row that can
 * be clicked twice before the server answered is a second folder.
 *
 * **The move block is a rejection, not a request.** `moveIsBlocked` asks `tree.selectors.ts` whether the
 * target is the folder itself or one of its descendants, and `move` throws `MoveBlockedError` *before*
 * `fetch` is called. The server enforces the same rule under the per-user advisory lock (§9.2 #14) and is the
 * only place the answer is true — but a dialog that could submit an illegal move would be a dialog whose
 * every failure is a bug report, and a browser that asked would be a wasted round-trip. `applyMove` is a
 * no-op for a blocked move so nothing paints a jump it then has to take back.
 */
import type { FolderNode, NoteNode, TreeResponse } from '@note-taker/contracts';
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../lib/api';
import { failureMessage } from '../auth/auth.api';
import { useSession } from '../auth/useSession';
import { createFolder, deleteFolder, deleteNote, patchFolder, patchNote } from './tree.api';
import { treeQueryKey } from './tree.queries';
import { descendantFolderIds, isDescendantOrSelf, type NodeKind } from './tree.selectors';

/** What is being renamed: the two lists of §9.2 #12, named. */
export interface RenameVars {
  readonly kind: NodeKind;
  readonly id: string;
  readonly name: string;
}

/** What is being moved. `null` is the root, and never means "unchanged" — see `tree.api.ts`. */
export interface MoveVars {
  readonly kind: NodeKind;
  readonly id: string;
  readonly parentId: string | null;
}

/** What is being deleted. `cascade` is `true` only after §5's typed-name confirmation. */
export interface DeleteVars {
  readonly kind: NodeKind;
  readonly id: string;
  readonly cascade?: boolean;
}

/**
 * A move the client refused to ask for.
 *
 * It is an `Error` and not an `ApiError` because nothing came back: no status, no code, no `requestId`. The
 * dialog renders it in the same place it renders a server's refusal, which is the point — from the user's
 * side the difference is one sentence, not two systems.
 */
export class MoveBlockedError extends Error {
  constructor(targetName: string) {
    super(`a folder cannot move inside itself — "${targetName}" is inside it`);
    this.name = 'MoveBlockedError';
  }
}

/**
 * The sentence to show for a failed mutation.
 *
 * `failureMessage` (PR-08) answers "the server did not answer" for anything it does not recognise, which is
 * right for a network failure and wrong for a client-side rule that has its own, more specific words.
 */
export function mutationFailureMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof MoveBlockedError) return error.message;
  return failureMessage(error);
}

/** The cache entry a mutation of this user's tree writes. `tree.queries.ts` exports the same key builder. */
export function treeCacheKey(userId: string): QueryKey {
  return treeQueryKey(userId);
}

/** Whether `cached` has the node at all, which is how a stale cache turns into a no-op rather than a lie. */
function hasNode(cached: TreeResponse, kind: NodeKind, id: string): boolean {
  return kind === 'folder'
    ? cached.folders.some((folder) => folder.id === id)
    : cached.notes.some((note) => note.id === id);
}

/**
 * Rename, in the cache. Untouched when the id is not there: a rename of a row this entry does not contain is
 * a cache that has already moved on, and rewriting the response to add a row the server never sent would be
 * inventing data.
 */
export function applyRename(cached: TreeResponse, vars: RenameVars): TreeResponse {
  if (!hasNode(cached, vars.kind, vars.id)) return cached;
  return vars.kind === 'folder'
    ? {
        ...cached,
        folders: cached.folders.map((folder) =>
          folder.id === vars.id ? { ...folder, name: vars.name } : folder,
        ),
      }
    : {
        ...cached,
        notes: cached.notes.map((note) => (note.id === vars.id ? { ...note, name: vars.name } : note)),
      };
}

/**
 * Move, in the cache — or, for a move `moveIsBlocked` would refuse, nothing at all.
 *
 * The blocked case lives *here* rather than only at the call sites because the two cannot be allowed to
 * disagree: a cache that painted a jump the request layer then refused to send would show a tree that was
 * never true for a second and reverted with no explanation.
 */
export function applyMove(cached: TreeResponse, vars: MoveVars): TreeResponse {
  if (!hasNode(cached, vars.kind, vars.id) || moveIsBlocked(cached, vars)) return cached;
  return vars.kind === 'folder'
    ? {
        ...cached,
        folders: cached.folders.map((folder) =>
          folder.id === vars.id ? { ...folder, parentId: vars.parentId } : folder,
        ),
      }
    : {
        ...cached,
        notes: cached.notes.map((note) =>
          note.id === vars.id ? { ...note, folderId: vars.parentId } : note,
        ),
      };
}

/**
 * Delete, in the cache, including what a folder delete takes with it.
 *
 * `cascade=true` on the server (§9.2 #15) deletes the whole subtree, and the cache must not keep rows that no
 * longer exist while it waits for the invalidation refetch — so the same `descendantFolderIds` set that the
 * move dialog bans is what gets removed here, folders and the notes filed under them.
 */
export function applyDelete(cached: TreeResponse, vars: DeleteVars): TreeResponse {
  if (!hasNode(cached, vars.kind, vars.id)) return cached;
  if (vars.kind === 'note') {
    return { ...cached, notes: cached.notes.filter((note) => note.id !== vars.id) };
  }
  const gone = descendantFolderIds(cached.folders, vars.id);
  return {
    folders: cached.folders.filter((folder) => !gone.has(folder.id)),
    notes: cached.notes.filter((note) => note.folderId === null || !gone.has(note.folderId)),
  };
}

/** What `onMutate` hands back to `onError`: the entry as it was, when there was one. */
interface Rollback {
  readonly previous: TreeResponse | undefined;
}

/**
 * The shared optimistic machinery: snapshot, write, send, restore, invalidate.
 *
 * `optimistic` is optional for the one mutation with nothing to roll back (a create, whose new row has no id
 * until the server answers) and `guarded` is the pre-flight that can refuse before `fetch` is reached. Both
 * are the same six lines, and having them once is the difference between "rollback" meaning four tested
 * behaviours and meaning twenty.
 */
function useTreeMutation<TVars, TRes>(options: {
  readonly key: QueryKey;
  readonly mutationFn: (vars: TVars) => Promise<TRes>;
  readonly optimistic?: (cached: TreeResponse, vars: TVars) => TreeResponse;
}) {
  const { key, mutationFn, optimistic } = options;
  const client = useQueryClient();

  return useMutation<TRes, unknown, TVars, Rollback>({
    mutationFn,
    onMutate: async (vars) => {
      // Read *before* anything is written: this is the only copy of the tree the server agrees with, and
      // `onError` puts it back verbatim rather than recomputing what it thinks was true.
      const previous = client.getQueryData<TreeResponse>(key);
      if (optimistic !== undefined && previous !== undefined) {
        client.setQueryData<TreeResponse>(key, optimistic(previous, vars));
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) client.setQueryData<TreeResponse>(key, context.previous);
    },
    // Not `onSuccess`: a rejected mutation changed the server's answer about the tree too (a rename that
    // lost a race, a delete that hit the emptiness gate), and an invalidating refetch is how the cache finds
    // out about the version of the tree that actually exists.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Whether this move is the illegal one: a folder into itself or under one of its descendants.
 *
 * Notes are never blocked — a note has no subtree, so there is no cycle to make (§9.2 #19's only rule is that
 * the destination folder belongs to the caller, which the server decides).
 */
export function moveIsBlocked(cached: TreeResponse, vars: MoveVars): boolean {
  if (vars.kind !== 'folder') return false;
  // The root is never inside anything, and a folder moved into itself is the smallest illegal case there is.
  if (vars.parentId === null) return false;
  if (vars.parentId === vars.id) return true;
  return isDescendantOrSelf(cached.folders, vars.parentId, vars.id);
}

/** Everything the sidebar and the three dialogs can ask the server to do to the tree. */
export interface CreateVars {
  /** A new folder: a name, and the parent it is created under (`null` is the root). */
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * The four mutations, bound to the signed-in user's cache entry.
 *
 * One hook rather than four, because every caller needs most of them (the context menu offers three of the
 * four) and because they share one `busy` flag: two optimistic writes in flight at once are two previews of a
 * tree that neither of them describes.
 *
 * The return type is inferred rather than written out, and `TreeMutations` names it: a mutation's own result
 * type carries its variables, its result and its context, and re-typing that here would be a fifth thing to
 * keep in sync with TanStack Query.
 */
export function useTreeMutations() {
  const { user } = useSession();
  const client = useQueryClient();
  const key = treeCacheKey(user?.id ?? '');

  /**
   * The cache as it stands, for the pre-flight that must not spend a request.
   *
   * With no entry there is nothing to check against, and the move goes unsent-but-unjudged: refusing it
   * because *this tab* has not loaded the tree yet would be a client that cannot move anything on a cold
   * start, and the server's check under the advisory lock is the authoritative one either way (§9.2 #14).
   */
  const cachedTree = () => client.getQueryData<TreeResponse>(key);

  const createFolderMutation = useTreeMutation<CreateVars, FolderNode>({
    key,
    mutationFn: ({ name, parentId }) => createFolder({ name, parentId }),
  });

  const renameMutation = useTreeMutation<RenameVars, FolderNode | NoteNode>({
    key,
    optimistic: applyRename,
    mutationFn: ({ kind, id, name }) =>
      kind === 'folder' ? patchFolder(id, { name }) : patchNote(id, { name }),
  });

  const moveMutation = useTreeMutation<MoveVars, FolderNode | NoteNode>({
    key,
    optimistic: applyMove,
    // The guard is inside `mutationFn`, not in the caller, so it cannot be skipped by a dialog that decided it
    // knew better — and so it runs *before* `fetch`, which is what makes "no request was sent" a property of
    // this file rather than of the mood the component happens to be in.
    mutationFn: async (vars) => {
      const cached = cachedTree();
      if (cached !== undefined && moveIsBlocked(cached, vars)) {
        throw new MoveBlockedError(targetName(cached, vars.parentId));
      }
      return vars.kind === 'folder'
        ? patchFolder(vars.id, { parentId: vars.parentId })
        : patchNote(vars.id, { folderId: vars.parentId });
    },
  });

  const removeMutation = useTreeMutation<DeleteVars, void>({
    key,
    optimistic: applyDelete,
    mutationFn: async (vars) => {
      if (vars.kind === 'folder') await deleteFolder(vars.id, vars.cascade === true);
      else await deleteNote(vars.id);
    },
  });

  return {
    createFolder: createFolderMutation,
    rename: renameMutation,
    move: moveMutation,
    remove: removeMutation,
    /**
     * Any of the four is in flight. One flag for the tree, because a mutation that arrives while another is
     * pending is a double-click, and this is the one surface where two answers are worse than a slow one.
     */
    busy:
      createFolderMutation.isPending ||
      renameMutation.isPending ||
      moveMutation.isPending ||
      removeMutation.isPending,
  };
}

/** The name of the hook's return type, so a component can spell its prop out. */
export type TreeMutations = ReturnType<typeof useTreeMutations>;

/** The target's name for the blocked-move sentence, or a phrase that says as little as possible. */
function targetName(cached: TreeResponse, parentId: string | null): string {
  if (parentId === null) return 'the root';
  return cached.folders.find((folder) => folder.id === parentId)?.name ?? 'that folder';
}
