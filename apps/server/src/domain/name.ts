/**
 * The server side of the name rules (docs/plans/mvp/MVP-09.md §5.5).
 *
 * `packages/contracts/src/names.ts` is the one implementation of the rules and stays that way; this module is
 * the thin wrapper the API needs around it and adds **no rule of its own**:
 *
 * * **Storage strips, display adds.** `notes.name` is extension-free (plan §8, `docs/DATA-MODEL.md §2`), and the
 *   only place that transform happens on a write is {@link storedNoteName} — one `stripMd`, the same one the
 *   validator ran on the raw value. A route that stripped and then a service that stripped again would be the
 *   `foo.md.md` → `foo.md` bug the contract's `nested-extension` rule exists to prevent, so nothing here calls
 *   `stripMd` twice on the same value.
 * * **The generated name is the contract's.** `new-file-<msepoch>.md` (`newFileName`) with the extension removed
 *   once, because the extension is display-only; `uniquify` then runs on that stored base, which is why
 *   `new-file-123-2` is possible and `new-file-123.md-2` never is.
 * * **A sibling clash is a `ConflictError` carrying the winner.** The message/detail pair is pinned by
 *   `docs/API.md §2`, so it is spelled once here: a double-clicked "Create" gets `error.data.id` and adopts the
 *   row that won instead of guessing whether its own insert landed.
 *
 * Folder names deliberately do **not** go through `stripMd`: `.md` is a note idea, and a folder legitimately
 * called `notes.md` must keep it (`names.ts` says the same, in the other direction).
 */
import { newFileName, stripMd, uniquify } from '@note-taker/contracts';

import { ConflictError } from '../domain/errors.js';

/**
 * The value to put in `notes.name` for a name a client sent.
 *
 * `undefined` is not accepted on purpose: the caller decides between "the client named it" and "generate one"
 * ({@link generatedNoteName}), and a `string | undefined` here would make an omitted name store the string
 * `"undefined"` — which is a name, and a legal one as far as every rule in `names.ts` is concerned.
 */
export function storedNoteName(name: string): string {
  return stripMd(name);
}

/**
 * The default name for a note created without one, **extension-free**:
 * `new-file-<msepoch>`.
 *
 * The clock is a parameter because the value is asserted character by character in
 * `services/note.service.int.test.ts`, and a test cannot pin `Date.now()` from outside.
 */
export function generatedNoteName(msEpoch: number = Date.now()): string {
  return stripMd(newFileName(msEpoch));
}

/**
 * A sibling-unique version of `base` (`plan-2`, `plan-3`, …).
 *
 * `taken` is the set of names the destination already holds, read from the database rather than assumed, so the
 * unique index stays the authority and this only avoids an avoidable insert.
 */
export function uniqueNoteName(base: string, taken: Iterable<string>): string {
  return uniquify(base, taken instanceof Set ? taken : new Set(taken));
}

/** Which entity's sibling set a clash happened in, so the sentence can name the thing that collided. */
export type ClashEntity = 'folder' | 'note';

/**
 * The `message` of a sibling clash, per entity. `docs/API.md §2` pins the note row character for character
 * (`name already exists in this folder`, with `details[].path` of `name`), and the folder row uses the same
 * sentence: at the root "this folder" reads oddly, but a second wording would mean a client that branches on
 * the text has two strings to compare against instead of one, and `error.data.id` is the machine-readable half.
 */
export const NAME_CLASH_MESSAGES: Readonly<Record<ClashEntity, string>> = {
  note: 'name already exists in this folder',
  folder: 'name already exists in this folder',
};

/** The `details[].message` of a sibling clash — the rule, not the sentence, in one place. */
export const NAME_CLASH_DETAIL_MESSAGE = 'must be unique among siblings';

/**
 * `CONFLICT` for "a sibling already has this name", carrying the winner's id (§9.1).
 *
 * @param existingId The row that already had the name, which becomes `error.data.id` so a double-clicked
 *   "Create" adopts it instead of guessing whether its own insert landed.
 */
export function nameClash(existingId: string, entity: ClashEntity): ConflictError {
  return new ConflictError(NAME_CLASH_MESSAGES[entity], {
    existingId,
    details: [{ path: 'name', message: NAME_CLASH_DETAIL_MESSAGE }],
  });
}
