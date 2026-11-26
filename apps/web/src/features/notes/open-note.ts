/**
 * Opening a note in the editor, and saying *why* this one deserves the caret (docs/plans/mvp/MVP-15.md §5).
 *
 * Two facts meet here and neither belongs to PR-15 alone. Creating a note has to leave the user inside it
 * — "after create, the note is open in the editor, focused, and the URL changed" is this brief's
 * acceptance criterion, not PR-13's — but the editor route (`routes/app/note/$noteId.tsx`) is PR-13's file
 * and the caret is its textarea. So PR-15 owns the *instruction* and PR-13 owns the *obedience*:
 *
 * ```tsx
 * // PR-15, on the create's success:
 * openNoteInEditor({ client, navigate }, note.id);
 * // PR-13, in the editor's mount effect:
 * if (takesEditorFocus(client, noteId)) textarea.focus();
 * ```
 *
 * **Why the intent is not in the URL.** `?focus=1` would be shared, bookmarked, and re-opened: "someone
 * created this note" is a fact about the last few seconds of this tab, not a property of the note, and a
 * URL that changes when the answer does is a URL that lies later. So the intent is one cache entry —
 * `['editor-focus']`, holding the id of the note this tab created last — which is per-`QueryClient`, dies
 * with a sign-out (PR-08's `client.clear()`), and is *read* rather than consumed: a one-shot `take` would
 * be devoured by the first pass of a `StrictMode` double-mount in `main.tsx` and the caret would silently
 * stop landing in development.
 *
 * **Why `navigate({ href })` and not `navigate({ to })`.** `to` is typed against the generated route tree,
 * and `/app/note/$noteId` is not in it yet: PR-13 creates that file. `href` is the same router's
 * documented escape hatch for a URL no route has declared, and it stops being needed the moment PR-13
 * merges — at which point the honest version of this call is
 * `navigate({ to: NOTE_EDITOR_PATH, params: { noteId } })`, with the marking unchanged. The constant is
 * exported so that swap is one line and not a hunt.
 */
import type { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '../../lib/queryClient';

/**
 * PR-13's route pattern, spelled here so the create path and the editor cannot drift while the route file
 * does not exist yet. Not a `to` value the type checker will accept — see the file header.
 */
export const NOTE_EDITOR_PATH = '/app/note/$noteId';

/** The address of one note in the editor: `/app/note/0198…`, with the id escaped on the way in. */
export function noteEditorHref(noteId: string): string {
  return `/app/note/${encodeURIComponent(noteId)}`;
}

/**
 * Records "this tab just created `noteId`", then navigates to it.
 *
 * The mark is written *before* the navigation because the editor can be mounted by the same commit that
 * processes it: mark-then-navigate is the only order that cannot lose the instruction.
 */
export function openNoteInEditor(
  {
    client,
    navigate,
  }: { readonly client: QueryClient; readonly navigate: (options: { readonly href: string }) => unknown },
  noteId: string,
): void {
  requestEditorFocus(client, noteId);
  navigate({ href: noteEditorHref(noteId) });
}

/** The mark itself: the id of the note this tab created most recently, and `undefined` before the first. */
export function requestEditorFocus(client: QueryClient, noteId: string): void {
  // One entry, overwritten: the question is "which note did this tab just create", and a cache full of
  // `true` flags answering it for every note created since sign-up is the same answer with a leak attached.
  client.setQueryData(queryKeys.editorFocus, noteId);
}

/**
 * What PR-13 asks on mount: should this note take the caret?
 *
 * Deliberately idempotent, and deliberately *not* cleared here — see the file header. The stale-`true`
 * case (create note A, click note B, click note A again) answers "yes" to a note the user is returning to,
 * which is a caret in a text box, not a data loss; the alternative is a flag that disappears on the mount
 * React decided to repeat.
 */
export function takesEditorFocus(client: QueryClient, noteId: string): boolean {
  return client.getQueryData(queryKeys.editorFocus) === noteId;
}
