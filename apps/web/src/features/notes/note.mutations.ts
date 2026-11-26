/**
 * The note write path, as the autosave engine needs it (docs/plans/mvp/MVP-14.md §7; §9.2 #16 and #18
 * of docs/API.md).
 *
 * Three calls and one factory:
 *
 * * `putNoteContent` — the versioned write PR-10 shipped. Every request carries
 *   `baseVersion = lastKnownServerVersion` (§6), and a mismatch answers `409 VERSION_CONFLICT` whose
 *   `data` is the pair the fork in §5 reads, so this file deliberately keeps the whole `ApiError`
 *   intact rather than flattening it into a message.
 * * `putNoteContentKeepalive` — the same `PUT` on the way out of the browser (§6). Normal
 *   `X-CSRF-Token` headers, `keepalive: true`, and no expectation that anybody reads the answer.
 * * `createNote` — the `404` escape hatch: the note was deleted elsewhere, and the honest way out is a
 *   **new** note, offered as a button, never done by the machine on its own.
 *
 * Everything goes through the `api` singleton, so the CSRF header, the one-shot refresh-and-replay and
 * the `401` hook are the ones PR-05 and PR-08 built and tested — an autosave transport with its own
 * fetch wrapper is how a save path ends up missing a header the server requires.
 */
import { type NoteWithContent, noteWithContentSchema, ROUTES } from '@note-taker/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SaveCall, SavedNote, SaveFn } from '../../lib/autosave';
import { queryKeys, TREE_KEY_PREFIX } from '../../lib/queryClient';

/** The body of §9.2 #18, spelled once. */
export interface ContentWrite {
  readonly content: string;
  readonly baseVersion: number;
}

/** `PUT /api/notes/:id/content` — the whole new plaintext against the version it was written from. */
export function putNoteContent(id: string, write: ContentWrite): Promise<NoteWithContent> {
  return api.json(ROUTES.noteContent(id), { method: 'PUT', body: write, schema: noteWithContentSchema });
}

/**
 * The unload write: the same `PUT`, with `keepalive: true` so the request can outlive the page that
 * started it.
 *
 * `undefined` means "it answered, but not with a note" — a `204`, an empty body, or something between
 * here and the app that replaced the response. Resolving rather than throwing is deliberate: a caller
 * that cannot read the reply still has to adopt *some* version, and inventing a failure here would
 * spend the retry budget of a machine whose page is already gone.
 */
export async function putNoteContentKeepalive(
  id: string,
  write: ContentWrite,
): Promise<NoteWithContent | undefined> {
  const response = await api.request(ROUTES.noteContent(id), {
    method: 'PUT',
    body: write,
    keepalive: true,
  });
  const text = await response.text();
  return parseNote(text);
}

/**
 * `POST /api/notes` with only a body and a folder: the "save as a new note" escape hatch.
 *
 * No `name` on purpose. §9.2 #16 says an omitted name is generated (`new-file-<msepoch>`) and
 * uniquified by the server, which is what keeps this call unable to lose a race against a sibling
 * name — and what keeps it from writing a row under the name the deleted note used, which somebody
 * else may have claimed in the meantime.
 */
export function createNoteFromBuffer(content: string, folderId: string | null): Promise<NoteWithContent> {
  return api.json(ROUTES.notes, {
    method: 'POST',
    body: { content, folderId },
    schema: noteWithContentSchema,
  });
}

function parseNote(text: string): NoteWithContent | undefined {
  if (text.length === 0) return undefined;
  try {
    return noteWithContentSchema.parse(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export interface ContentSaverOptions {
  /**
   * Called with the row after each confirmed write, so the caller can keep the `['note', id]` cache
   * entry and the sidebar's `contentUpdatedAt` in step with what the server has.
   */
  readonly onSaved?: (note: NoteWithContent) => void;
}

/**
 * Binds {@link putNoteContent} to one note id and to the engine's `save` signature.
 *
 * The `keepalive` branch has to answer "what version is the row at now?" and a body-less `2xx` does
 * not say. PR-10's answer is `version: version + 1` unconditionally (§9.2 #18), so the arithmetic is
 * knowable even when the reply is not, and adopting `baseVersion + 1` costs nothing if it turns out
 * to be wrong: the next write conflicts, the payload equals the snapshot, and §5's fork adopts the
 * real version with no banner and no pause.
 */
/**
 * What a confirmed write owes the caches, and the shape of that debt is deliberate.
 *
 * `['note', id]` gets `setQueryData`, not an invalidation: this row is the one thing in the app a
 * write moves, and invalidating it would schedule a `GET` whose answer is the text the user is
 * currently typing past. Whatever PR-13 renders from, it should not be a response that races the
 * keyboard.
 *
 * The tree is marked stale with `refetchType: 'none'`, because autosave fires every debounce window —
 * a full tree refetch every 1.2 s of typing to refresh one sidebar timestamp is the definition of a
 * chatty client. The next mount (or the next rename) picks it up.
 */
export function syncSavedNote(client: QueryClient, id: string, note: NoteWithContent): void {
  client.setQueryData<NoteWithContent>(queryKeys.note(id), note);
  void client.invalidateQueries({ queryKey: TREE_KEY_PREFIX, refetchType: 'none' });
}

export function createContentSaver(id: string, options: ContentSaverOptions = {}): SaveFn {
  return async (call: SaveCall): Promise<SavedNote> => {
    const write: ContentWrite = { content: call.content, baseVersion: call.baseVersion };

    if (call.via === 'keepalive') {
      const note = await putNoteContentKeepalive(id, write);
      if (note === undefined) return { version: call.baseVersion + 1 };
      options.onSaved?.(note);
      return { version: note.version };
    }

    const note = await putNoteContent(id, write);
    options.onSaved?.(note);
    return { version: note.version };
  };
}
