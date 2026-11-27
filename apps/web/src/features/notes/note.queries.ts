/**
 * One note's plaintext, as server state (docs/plans/mvp/MVP-13.md §4 — the read side; the write side is
 * `note.mutations.ts`, which is PR-14's).
 *
 * `GET /api/notes/:id` (§9.2 #17) is the only endpoint in the app that answers with plaintext, and the only
 * one whose response carries a `version`. Both facts show up in this file's shape.
 *
 * **The cache entry is read on entry and then left alone.** A confirmed write updates it with `setQueryData`
 * (`syncSavedNote` in `note.mutations.ts`), never with an invalidation: a refetch scheduled after every save
 * is a response racing the keyboard, and the version the editor would adopt from it is the server's answer to
 * a question the editor had already answered. So this query *loads* the note, and from then on the buffer
 * owns the text and PR-14's machine owns the version — which is why `refetchOnWindowFocus` is off globally
 * (`lib/queryClient.ts`) and nothing here asks for a background refresh of a note that is open in a text area.
 * The one moment a stale row must win is the conflict banner, and that arrives as a `409` payload rather than
 * as a fetch.
 *
 * **`ETag: W/"v7"` is not used** (`docs/API.md` #17/#18, Concurrency). The client sends `baseVersion` in the
 * body and `If-Match` is the optional half of the contract. A second copy of the version in a header this
 * client would have to parse, store and compare is a second way to be wrong about which write wins, and the
 * conflict response names the body's number, not the header's.
 */
import { type NoteWithContent, noteWithContentSchema, ROUTES } from '@note-taker/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';

/** `GET /api/notes/:id` — the row, decrypted, with `content` and `version` (§9.2 #17). */
export function fetchNote(id: string): Promise<NoteWithContent> {
  return api.json(ROUTES.note(id), { schema: noteWithContentSchema });
}

/**
 * `['note', id]` plus its fetcher.
 *
 * `enabled` is not a formality: a route can be mounted with an id its caller is about to replace (a click on
 * a second row while the first is still settling), and `GET /api/notes/` with an empty id is a request that
 * can only answer `400 VALIDATION` while a page that has not loaded yet pretends to be fetching.
 */
export function noteOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.note(id),
    queryFn: () => fetchNote(id),
    enabled: id.length > 0,
  });
}

/** The note this page is about. See {@link noteOptions} for what its cache entry is allowed to do. */
export function useNote(id: string) {
  return useQuery(noteOptions(id));
}
