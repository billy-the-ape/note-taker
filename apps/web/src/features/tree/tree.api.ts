/**
 * The tree's HTTP surface: `GET /api/tree` and the five folder/note mutations PR-12 offers
 * (docs/plans/mvp/MVP-12.md §5, docs/plans/mvp/MVP-09.md §4 #12–#16, #19–#20).
 *
 * Same shape as `features/auth/auth.api.ts`, which is the house style since PR-08: `api.json(path,
 * { schema })`, so a request leaves with the CSRF header PR-05 attaches, a response is checked against the
 * schema the server was compiled against, and every failure is an `ApiError` carrying the server's own
 * words, its code, and the `requestId` worth pasting into a support note. Nothing here decides anything —
 * ownership, the sibling-unique name, the cycle rule, the 100-level cap and the emptiness gate all live in
 * `apps/server/src/services/`, and the payloads below are the transport, not the policy.
 *
 * Three transport details that are worth naming because they are easy to get quietly wrong:
 *
 * * **`?cascade=true`, never `?cascade=1`** (§9.2 #15): the server's `deleteOptionsSchema` refuses anything
 *   but the literal string, and `cascade=false` means "do not cascade" — a truthy-coercion bug there is a
 *   deleted subtree. So the flag is a boolean in this signature and the query string is built here, once.
 * * **`PATCH` carries only what changed.** `patchFolderSchema`/`renameMoveSchema` refuse an empty body
 *   because an empty patch is a form that forgot to send its edit; sending `name` *and* `folderId` when only
 *   one changed would be a lie about intent the server would happily accept.
 * * **`204` has no body**, so `api.json` resolves `undefined` and the caller must not expect the updated row.
 *   That is the whole reason the cache rewrite in `tree.mutations.ts` happens optimistically rather than
 *   from a response.
 */
import {
  type CreateFolderRequest,
  type FolderNode,
  folderSchema,
  type NoteNode,
  noteSchema,
  type PatchFolderRequest,
  type RenameMoveRequest,
  ROUTES,
  type TreeResponse,
  treeResponseSchema,
} from '@note-taker/contracts';

import { api } from '../../lib/api';

/** §9.2 #12 — the caller's whole tree, metadata only, in one request. Never needs a key. */
export function fetchTree(): Promise<TreeResponse> {
  return api.json(ROUTES.tree, { schema: treeResponseSchema });
}

/**
 * §9.2 #13 — a new folder. An omitted `parentId` means the root, which is what the sidebar's "New folder"
 * button sends and what the context menu does *not* (it names the selected folder).
 */
export function createFolder(body: CreateFolderRequest): Promise<FolderNode> {
  return api.json(ROUTES.folders, { method: 'POST', body, schema: folderSchema });
}

/**
 * §9.2 #14 — rename and/or move a folder, one request.
 *
 * The body is built by the caller rather than assembled here, because "only the name changed" and "only the
 * parent changed" are different requests and `parentId: null` (a move to the root) has to stay
 * distinguishable from `parentId` absent. An empty body is refused by the contract, so a caller that passed
 * no change would be reporting a bug rather than moving a folder.
 */
export function patchFolder(id: string, body: PatchFolderRequest): Promise<FolderNode> {
  return api.json(ROUTES.folder(id), { method: 'PATCH', body, schema: folderSchema });
}

/** §9.2 #19 — rename and/or move a note; `folderId: null` is the root of the tree. */
export function patchNote(id: string, body: RenameMoveRequest): Promise<NoteNode> {
  return api.json(ROUTES.note(id), { method: 'PATCH', body, schema: noteSchema });
}

/**
 * §9.2 #15 — delete a folder.
 *
 * A non-empty folder without `cascade` answers `409 CONFLICT`; with it, the subtree goes. `cascade` is only
 * ever `true` after §5's typed-name confirmation, which is why this is a parameter rather than a default.
 */
export function deleteFolder(id: string, cascade = false): Promise<void> {
  const path = cascade ? `${ROUTES.folder(id)}?cascade=true` : ROUTES.folder(id);
  return api.json(path, { method: 'DELETE' });
}

/** §9.2 #20 — delete one note. Notes have no children, so there is nothing to cascade. */
export function deleteNote(id: string): Promise<void> {
  return api.json(ROUTES.note(id), { method: 'DELETE' });
}
