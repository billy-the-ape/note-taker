/**
 * Folder DTOs (docs/plans/mvp/MVP-05.md §7, plan §9.2 #13–#15).
 *
 * Folder names follow the note-name character and length rules with **no extension handling** —
 * `.md` is a note idea, and a folder called `notes.md` is legitimate.
 *
 * The shape stored here is `FolderNode` (see `tree.schemas.ts`); `parentId: null` means the root of
 * the tree, mirroring `folders.parent_id` in plan §8.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './api-envelope.js';
import { folderNameIssue } from './names.js';

export const folderIdSchema = z.uuid();

/**
 * Deepest legal folder index: the root is depth `0`, so `99` is level 100 and creating or moving to
 * depth `100` is a `VALIDATION` error (§9.2 #13). PR-09 enforces it; the constant lives in the
 * contract so the message the API returns and the tree the UI walks agree on the same number.
 */
export const FOLDER_MAX_DEPTH = 99;

/**
 * The move-cap rule of §9.2 #14: `depth(newParent) + 1 + height(movedSubtree) <= 99`, which also
 * covers a plain create (its subtree height is `0`).
 *
 * A deep subtree re-parented under a shallow root has to fail too, which is why this takes the
 * height instead of only the parent's depth.
 */
export function fitsWithinFolderDepth(parentDepth: number, subtreeHeight = 0): boolean {
  return parentDepth >= 0 && subtreeHeight >= 0 && parentDepth + 1 + subtreeHeight <= FOLDER_MAX_DEPTH;
}

/** The stored folder row, i.e. a tree node: metadata only, never contents or child lists (§9.2 #12). */
export const folderSchema = z.object({
  id: folderIdSchema,
  name: z.string().min(1),
  parentId: folderIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Folder = z.infer<typeof folderSchema>;

/** `POST /api/folders` (§9.2 #13): `{name, parentId|null}`. Omitting `parentId` means the root. */
export const createFolderSchema = z
  .object({
    name: z.string(),
    parentId: folderIdSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const issue = folderNameIssue(value.name);
    if (issue !== undefined) ctx.addIssue(issue);
  });
export type CreateFolderRequest = z.infer<typeof createFolderSchema>;

/**
 * `PATCH /api/folders/:id` (§9.2 #14): rename and/or move. An empty body is refused — it is always
 * the symptom of a form that forgot to send what changed, and answering `200` to it would tell the
 * caller their edit was saved when it was not.
 */
export const patchFolderSchema = z
  .object({
    name: z.string().optional(),
    parentId: folderIdSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.name === undefined && value.parentId === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'must change name and/or parentId' });
    }
    if (value.name !== undefined) {
      const issue = folderNameIssue(value.name);
      if (issue !== undefined) ctx.addIssue(issue);
    }
  });
export type PatchFolderRequest = z.infer<typeof patchFolderSchema>;

/**
 * `?cascade=true`, the way a query string can express it.
 *
 * Only the literal `true` enables a cascade delete: `z.coerce.boolean()` would read `cascade=false`
 * as `true`, and the difference is a folder tree that silently vanishes. Anything else fails
 * validation instead of guessing.
 */
const cascadeQuerySchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

/** `DELETE /api/folders/:id` (§9.2 #15): without `cascade=true` a non-empty folder answers `CONFLICT`. */
export const deleteOptionsSchema = z.object({ cascade: cascadeQuerySchema });
export type DeleteOptions = z.infer<typeof deleteOptionsSchema>;

/** The `:id` path parameter, so a non-UUID id fails as `VALIDATION` before it reaches SQL. */
export const folderIdParamsSchema = z.object({ id: folderIdSchema });
