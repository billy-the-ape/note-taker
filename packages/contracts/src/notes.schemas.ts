/**
 * Note DTOs (docs/plans/mvp/MVP-05.md §7–§8, plan §9.2 #16–#20).
 *
 * Two shapes matter and they differ by one field on purpose:
 *
 * * `noteSchema` — the **metadata** row (`NoteNode` in the endpoint table): no content, because the
 *   tree must be servable without decrypting anything (plan §10 encrypts content only).
 * * `noteWithContentSchema` — the same row plus `content`, which only `POST /api/notes` and
 *   `GET`/`PUT /api/notes/:id/content` return, i.e. only where a key was actually used.
 *
 * `name` is stored **extension-free**; `names.ts` owns the rules, this module only turns a violated
 * rule into a field error (the `superRefine` of MVP-05 §8).
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './api-envelope.js';
import { folderIdSchema } from './folders.schemas.js';
import { noteNameIssue } from './names.js';

export const noteIdSchema = z.uuid();

/**
 * `notes.version` (plan §8): starts at `1` and increments on every content write. It is what makes
 * writes versioned rather than last-write-wins, so a client sends it back as `baseVersion`.
 */
export const noteVersionSchema = z.number().int().min(1);

/** The 1 MiB note-body cap of §9.2, matching `MAX_NOTE_BYTES` (default) at the transport layer. */
export const NOTE_CONTENT_MAX_BYTES = 1024 * 1024;

/** The UI warning threshold of §9.2 (900 KiB): a dirty buffer past this warns before it fails. */
export const NOTE_CONTENT_WARN_BYTES = 900 * 1024;

/**
 * UTF-8 byte length, computed without `Buffer` or `TextEncoder`.
 *
 * This package is imported by the browser bundle as well as the API, so the byte rule has to be
 * expressible in plain ECMAScript — `lib` here is `ES2023` only, and a Node global would have to be
 * polyfilled by Vite to survive it.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : Number.NaN;
      if (low >= 0xdc00 && low <= 0xdfff) {
        // A surrogate pair is one code point: 4 bytes, and it consumes the low half.
        index += 1;
        bytes += 4;
        continue;
      }
      // A dangling surrogate is not encodable; every encoder in reach replaces it with U+FFFD, which is 3.
      bytes += 3;
      continue;
    }
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** The `content` field error for a body past the cap; `VALIDATION` here, `PAYLOAD_TOO_LARGE` at the transport. */
function oversizedContentIssue(content: string) {
  const bytes = utf8ByteLength(content);
  if (bytes <= NOTE_CONTENT_MAX_BYTES) return undefined;
  return {
    code: 'custom' as const,
    path: ['content'],
    message: `must be at most ${NOTE_CONTENT_MAX_BYTES} bytes (got ${bytes})`,
  };
}

/** A note row without its content: what `GET /api/tree` and `PATCH /api/notes/:id` return. */
export const noteSchema = z.object({
  id: noteIdSchema,
  /** Extension-free (plan §8). Display adds `.md` back with `withMd()`. */
  name: z.string().min(1),
  /** `null` is the root of the tree, mirroring `notes.folder_id`. */
  folderId: folderIdSchema.nullable(),
  version: noteVersionSchema,
  /** Plaintext byte length, so a list can show a size without decrypting. */
  contentBytes: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  contentUpdatedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Note = z.infer<typeof noteSchema>;

/** `201` of `POST /api/notes` and the body of `GET /api/notes/:id` / `PUT …/content` (§9.2 #16–#18). */
export const noteWithContentSchema = noteSchema.extend({ content: z.string() });
export type NoteWithContent = z.infer<typeof noteWithContentSchema>;

/**
 * `POST /api/notes` (§9.2 #16).
 *
 * Every field is optional, which is the whole design of the endpoint: "new note" with an empty body
 * is a valid request. No `name` means the server generates `new-file-<msepoch>.md` with `newFileName`
 * and `uniquify` (so it needs no name from the client, and PR-15 prefills one for editing); no
 * `content` means the row is sealed with the empty string, never an empty cipher; no `folderId`
 * means the root.
 */
export const createNoteSchema = z
  .object({
    name: z.string().optional(),
    folderId: folderIdSchema.nullable().default(null),
    content: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.name !== undefined) {
      const issue = noteNameIssue(value.name);
      if (issue !== undefined) ctx.addIssue(issue);
    }
    if (value.content !== undefined) {
      const issue = oversizedContentIssue(value.content);
      if (issue !== undefined) ctx.addIssue(issue);
    }
  });
export type CreateNoteRequest = z.infer<typeof createNoteSchema>;

/**
 * `PATCH /api/notes/:id` (§9.2 #19): rename and/or move, where `folderId: null` moves to the root.
 * An empty body is refused for the same reason a folder's is (§9.2 #14).
 */
export const renameMoveSchema = z
  .object({
    name: z.string().optional(),
    folderId: folderIdSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.name === undefined && value.folderId === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'must change name and/or folderId' });
    }
    if (value.name !== undefined) {
      const issue = noteNameIssue(value.name);
      if (issue !== undefined) ctx.addIssue(issue);
    }
  });
export type RenameMoveRequest = z.infer<typeof renameMoveSchema>;

/**
 * `PUT /api/notes/:id/content` (§9.2 #18): the whole new plaintext plus the version it was written
 * against. A mismatch is not an error to lose — the API answers `VERSION_CONFLICT` carrying the
 * current server `content` and `version`, which is PR-14's comparison input.
 */
export const contentUpdateSchema = z
  .object({
    content: z.string(),
    baseVersion: noteVersionSchema,
  })
  .superRefine((value, ctx) => {
    const issue = oversizedContentIssue(value.content);
    if (issue !== undefined) ctx.addIssue(issue);
  });
export type ContentUpdateRequest = z.infer<typeof contentUpdateSchema>;

/** The `:id` path parameter, so a non-UUID id fails as `VALIDATION` before it reaches SQL. */
export const noteIdParamsSchema = z.object({ id: noteIdSchema });
