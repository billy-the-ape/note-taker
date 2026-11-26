/**
 * The web app's half of the note-name rules (docs/plans/mvp/MVP-15.md §4).
 *
 * This file is a **wrapper, not a second authority**. Every rule — the character set, the 120-character
 * cap, the one-suffix `stripMd`, the `uniquify` sequence, the `new-file-<msepoch>.md` format — stays in
 * `@note-taker/contracts` `names.ts`, because that module is also what PR-09's routes enforce on the way
 * in and what the seed script generates with. Two copies of a name rule is how a dialog starts accepting
 * a name the API then refuses, which is the exact bug PR-05 exists to prevent.
 *
 * So this module does two things and nothing else:
 *
 * * It **re-exports** the contract API under the names the components use, so `components/` imports
 *   `../../lib/name` and never reaches past the app's own boundary into the shared package for a string
 *   helper. (Rename a rule here and every dialog in the app follows; that is the point of the indirection.)
 * * It states the three **compositions** the dialogs need, each of which is a call-or-two over the
 *   contract and none of which adds a rule: what the field error should say, what name the new-note form
 *   starts on, and what name actually goes in the request body.
 *
 * What lives elsewhere on purpose: anything that has to know the shape of the tree (which names a sibling
 * already took) is in `features/notes/new-note.ts`, not here.
 */
import {
  NAME_REJECTION_MESSAGES,
  type NameRejection,
  newFileName,
  noteNameRejection,
  stripMd,
  uniquify,
} from '@note-taker/contracts';

// The contract's own API, re-exported rather than restated: `isValidNoteName` is the predicate,
// `withMd`/`stripMd` are the display/storage pair, and `MD_EXT` is the only place the extension is
// spelled in this app's source — the fixed suffix in the dialog renders this constant, so the label and
// the rule cannot disagree about what the extension is.
export {
  endsInMd,
  FOLDER_NAME_MAX,
  folderNameRejection,
  isValidFolderName,
  isValidNoteName,
  MD_EXT,
  NAME_REJECTION_MESSAGES,
  NOTE_NAME_MAX,
  newFileName,
  noteNameRejection,
  stripMd,
  uniquify,
  withMd,
} from '@note-taker/contracts';

/** The rule a value broke, in the contract's own words — the text a `Field` renders as its error. */
export type NameProblem = {
  readonly rejection: NameRejection;
  readonly message: string;
};

/**
 * Why `value` cannot be submitted, or `undefined` when it can.
 *
 * The message is `NAME_REJECTION_MESSAGES[...]` verbatim, so the sentence under the input is the same
 * sentence the API puts in its `details[]` when a client skipped this check (or is a different client
 * altogether — the CLI, a future mobile app). "The dialog and the server said the same thing" is a
 * property of the app, and it holds because there is one string to say it.
 */
export function noteNameProblem(value: string): NameProblem | undefined {
  const rejection = noteNameRejection(value);
  return rejection === undefined ? undefined : { rejection, message: NAME_REJECTION_MESSAGES[rejection] };
}

/**
 * The name the **request body** carries: the typed value with one `.md` removed.
 *
 * The dialog's input cannot contain the suffix in the first place (it is a sibling element, not part of
 * the value), so this is a no-op for every name typed in this form. It stays because the alternative is
 * trusting the caller: `notes.name` is documented extension-free, and the belt is cheap next to the row a
 * missing pair would write — `report.md` stored instead of `report` renders as `report.md.md` the next
 * time the dialog prefills from it.
 */
export function submittedName(value: string): string {
  return stripMd(value);
}

/**
 * The prefill for a new note in a folder whose siblings already took `taken`:
 * `new-file-1700000000000`, or `new-file-1700000000000-2` when that one is gone.
 *
 * `msEpoch` is a parameter rather than a `Date.now()` call inside because "two dialogs opened in the same
 * millisecond still get different names" is an acceptance criterion, and a form of this function that
 * reads the clock itself cannot be tested without faking time globally. `uniquify` strips any extension
 * before it compares, so the display form `newFileName()` produces is a legal input here — which is the
 * same reason the request body and the cache agree (§8 of MVP-05).
 */
export function newNoteBaseName(msEpoch: number, taken: ReadonlySet<string>): string {
  return uniquify(newFileName(msEpoch), taken);
}
