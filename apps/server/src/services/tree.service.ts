/**
 * `GET /api/tree`: the caller's whole tree as metadata, in one request (docs/plans/mvp/MVP-09.md §5.6, plan
 * §9.2 #12).
 *
 * The response is the contract's two **flat** lists — `folders` and `notes`, each a node with a `parentId`/
 * `folderId` — and re-nesting is the client's job. That is not laziness: `folderNodeSchema` and `noteNodeSchema`
 * are flat objects in `@note-taker/contracts`, and PR-09 may not change a contract, so building `children`
 * arrays server-side would be inventing a shape the client cannot validate.
 *
 * Two statements, and that is the honest minimum rather than an N+1:
 *
 * * the folder half is `listFolderTree`, one recursive CTE that also walks each row's breadcrumb path;
 * * the note half is one flat select, because a note has one `folder_id` and no children, so there is nothing
 *   for recursion to earn.
 *
 * Neither is per-folder: no request here costs one query per directory, which is what "the tree is one request"
 * is really promising.
 *
 * The walk's `depth` and `path` are deliberately **not** in the response. The contract's node has no field for
 * them, and the response must contain no `content` field at all — a tree that carried bodies would need the key
 * for every note in the install and would make `GET /api/tree` the most expensive request in the product (plan
 * §10 encrypts content only, and the tree is servable without decrypting anything).
 */
import type { TreeResponse } from '@note-taker/contracts';

import type { Db } from '../db/client.js';
import { listFolderTree } from '../db/repositories/folders.repo.js';
import { listNotesForTree } from '../db/repositories/notes.repo.js';
import { toFolderNode } from './folder.service.js';
import { toNoteNode } from './note.service.js';

export interface TreeService {
  /** Both lists, folders then notes, each in `collate "C"` name order (§4 #12). */
  readonly get: (input: { readonly userId: string }) => Promise<TreeResponse>;
}

/** Builds the service over one pool; `buildApp()` registers one per process. */
export function createTreeService(options: { readonly db: Db }): TreeService {
  const { db } = options;

  return {
    async get({ userId }): Promise<TreeResponse> {
      // Issued together: the two lists are one response, and awaiting them in series would double the latency
      // for no ordering benefit, since each statement already sorts itself.
      const [folderRows, noteRows] = await Promise.all([
        listFolderTree(db, { userId }),
        listNotesForTree(db, { userId }),
      ]);
      return {
        folders: folderRows.map(toFolderNode),
        notes: noteRows.map(toNoteNode),
      };
    },
  };
}
