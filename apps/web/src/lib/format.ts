/**
 * The one place a timestamp is turned into words (PR-12 drew this inside
 * `routes/app/index.tsx`; PR-13 moved it here because the note editor's facts row says the same sentence and
 * two pages copying a formatting rule is how they start disagreeing about one note).
 *
 * Byte counts are **not** here: `lib/note-size.ts` owns them, because a note's size is a question about the
 * contract's caps and not about a number's appearance.
 */

/**
 * The one place a timestamp is turned into words.
 *
 * Deliberately not `toLocaleString`: that is a different string in every container's locale, and a test that
 * asserts "the note looks recent" against a date the CI image's `TZ` decides is not a test. This is the
 * machine-readable form, shortened to the day an operator scans for.
 */
export function formatInstant(iso: string): string {
  return iso.slice(0, 10);
}
