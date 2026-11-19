/**
 * The tree response (docs/plans/mvp/MVP-05.md §7, plan §9.2 #12): `GET /api/tree` returns the whole
 * tree as two flat lists — folder nodes and note nodes — assembled by one recursive CTE server-side
 * (plan A.4) and re-nested on the client.
 *
 * Metadata only, **never content**: notes live at the root of the tree as well as inside folders
 * (`folderId: null`), and both lists are un-ordered by contract, so the UI sorts by name.
 *
 * The two node schemas are the entity modules' own row shapes, aliased under the names the endpoint
 * table uses. Defining them twice is how a contract starts lying, so this file adds the response
 * wrapper and nothing else.
 */
import { z } from 'zod';

import { folderSchema } from './folders.schemas.js';
import { noteSchema } from './notes.schemas.js';

/** A folder of the tree: `{id, name, parentId, createdAt, updatedAt}`. */
export const folderNodeSchema = folderSchema;
export type FolderNode = z.infer<typeof folderNodeSchema>;

/** A note of the tree: the metadata row, with no `content` field to leak. */
export const noteNodeSchema = noteSchema;
export type NoteNode = z.infer<typeof noteNodeSchema>;

/** `200` of `GET /api/tree`. */
export const treeResponseSchema = z.object({
  folders: z.array(folderNodeSchema),
  notes: z.array(noteNodeSchema),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;
