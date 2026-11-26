/**
 * Creating a note from the browser (docs/plans/mvp/MVP-15.md §5), plus the two tree-cache reads the
 * dialog needs to decide whether a name is still free.
 *
 * **Why the tree is read from the cache and not from the API.** §5's uniqueness check is "debounced
 * against the tree cache — **no extra endpoint**". `GET /api/tree` (§9.2 #12) already returned every
 * sibling's name the moment the sidebar rendered, so a "is this name free?" round-trip would be a fourth
 * request per keystroke to re-learn a list this tab is holding. The consequence is honest and worth
 * stating: the check is a *courtesy*, and the server decides. A sibling created in another tab after the
 * tree was fetched loses the race here and wins at the API, and `POST /api/notes` answers `409 CONFLICT`
 * with the winner's id — which is why the dialog keeps the whole `ApiError` rather than flattening it.
 *
 * **Why the tree entry is written on success rather than on submit.** An optimistic create needs an id to
 * put in the tree before the response arrives, and this one does not have it: `POST /api/notes` mints the
 * note's UUIDv7 server-side, and `createNoteSchema` has no `id` field to send. A client-made id would put
 * `/app/note/<somebody-else's-uuid>` in the sidebar for the length of the request — a row that renders,
 * takes a click, and answers `404` — so the row appears when the server's id appears. Nothing is rolled
 * back because nothing lied, and the dialog's Create button is disabled while the request is in flight,
 * which is the double-create this cache bookkeeping would otherwise have to survive.
 */
import {
  type NoteNode,
  type NoteWithContent,
  noteSchema,
  noteWithContentSchema,
  ROUTES,
  type TreeResponse,
  treeResponseSchema,
} from '@note-taker/contracts';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { newNoteBaseName, stripMd } from '../../lib/name';
import { queryKeys, TREE_KEY_PREFIX } from '../../lib/queryClient';

/** What the dialog knows before there is a note: a name without its extension, and a folder or the root. */
export interface NewNoteRequest {
  readonly name: string;
  /** `null` is the root of the tree, which is what "nothing selected" means (§9.2 #16). */
  readonly folderId: string | null;
}

/**
 * `POST /api/notes` (§9.2 #16). No `content`: an omitted one is sealed as the empty string server-side,
 * which is a real envelope and not an empty cipher, and the editor PR-13 puts the first keystroke in.
 *
 * A `409` arrives as an `ApiError` whose `data.id` is the sibling that won; the caller decides what to say
 * (see `NewNoteDialog`), so nothing is caught here.
 */
export function createNote(request: NewNoteRequest): Promise<NoteWithContent> {
  return api.json(ROUTES.notes, {
    method: 'POST',
    body: { name: request.name, folderId: request.folderId },
    schema: noteWithContentSchema,
  });
}

/**
 * The tree this tab is holding for `userId`, or `undefined` when it has none.
 *
 * Read with `getQueryData`, not `useQuery`: the dialog is not a tree view and must not subscribe one
 * into existence (a `useQuery` here would `fetch` `/api/tree` on a miss, which is the extra request §5
 * forbids). `treeResponseSchema.safeParse` rather than a cast because a cache entry can predate a
 * contract, and a `false` answer means "no information", which is a safe answer here and a wrong one
 * nowhere else in the app.
 */
export function readTreeCache(client: QueryClient, userId: string | null): TreeResponse | undefined {
  if (userId === null) return undefined;
  const cached: unknown = client.getQueryData(queryKeys.tree(userId));
  const parsed = treeResponseSchema.safeParse(cached);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The names the target folder's other notes already use, extension-free, including a sibling in the root
 * (`folderId: null`) when the target *is* the root.
 *
 * Folder names are deliberately absent: `folders.name` and `notes.name` are separate unique indexes
 * (docs/DATA-MODEL.md), so a folder called `todo` does not stop a note called `todo.md`, and refusing
 * names the server would accept is a bug the user pays for.
 */
export function takenSiblingNames(
  tree: TreeResponse | undefined,
  folderId: string | null,
): ReadonlySet<string> {
  if (tree === undefined) return new Set();
  return new Set(tree.notes.filter((note) => note.folderId === folderId).map((note) => note.name));
}

/**
 * The name the new-note form opens with: `new-file-<ms>`, uniquified against the target folder.
 *
 * The tree is a parameter so the caller decides *which* cache read this is (the dialog passes
 * `readTreeCache(...)`) and a test can pass a literal. `Date.now()` is the default for the same reason
 * `newNoteBaseName`'s `msEpoch` is a parameter: the same-millisecond case in §6 is proven by injecting a
 * fixed clock at the call site, and both halves stay pure.
 */
export function prefillNoteName(
  tree: TreeResponse | undefined,
  folderId: string | null,
  msEpoch: number = Date.now(),
): string {
  return newNoteBaseName(msEpoch, takenSiblingNames(tree, folderId));
}

/**
 * `true` when `name` is already a sibling of `folderId`.
 *
 * `name` goes through `stripMd` first, because the two spellings of one note are the same collision: a
 * cached row called `todo` is taken by the value `todo`, by the value `todo.md`, and by whatever a paste
 * dragged in behind them. An empty value is not taken by anything, and asks nothing of the cache.
 */
export function isSiblingNameTaken(
  tree: TreeResponse | undefined,
  folderId: string | null,
  name: string,
): boolean {
  const base = stripMd(name);
  return base.length > 0 && takenSiblingNames(tree, folderId).has(base);
}

/** The metadata row of a created note: what the tree's `notes[]` holds, with no `content` field. */
export function noteNodeOf(note: NoteWithContent): NoteNode {
  // `parse`, not a cast: `z.object` drops the keys it does not declare, so this is how a
  // `NoteWithContent` becomes a `NoteNode` without hand-listing the fields that must not be copied —
  // `content` among them. Plaintext has no business being in a `['tree', userId]` entry (§9.2 #12).
  return noteSchema.parse(note);
}

/**
 * The confirmed row, added to the tree cache so the sidebar grows without a refetch.
 *
 * No-ops when this tab has never fetched that user's tree: inventing a `{folders: [], notes: [note]}`
 * entry would make the sidebar render one note and call that the whole tree, and the next real fetch
 * would look like it had lost things. Absent stays absent, and the next mount asks the API.
 */
export function addNoteToTreeCache(client: QueryClient, userId: string | null, note: NoteWithContent): void {
  const tree = readTreeCache(client, userId);
  if (userId === null || tree === undefined) return;
  client.setQueryData(queryKeys.tree(userId), {
    folders: tree.folders,
    notes: [...tree.notes, noteNodeOf(note)],
  });
}

/**
 * The mutation the dialog drives: `mutate({name, folderId}, {onSuccess, onError})`.
 *
 * A confirmed create owes the caches two entries, both of which are the difference between an editor that
 * opens now and one that opens after a round-trip: `['note', id]` gets the row the `POST` just returned
 * (with its content, its version, and the id PR-13's route needs), and `['tree', userId]` gets its
 * metadata half. The tree is then marked stale with `refetchType: 'none'` so the *next* sidebar mount
 * re-reads it without this one fetching a whole tree to add one row.
 *
 * `retry: false` comes from `createQueryClient`'s mutation defaults and is load-bearing: a re-sent
 * `POST /api/notes` is a second note.
 */
export function useCreateNoteMutation(userId: string | null) {
  const client = useQueryClient();

  return useMutation<NoteWithContent, Error, NewNoteRequest>({
    mutationFn: (request) => createNote(request),
    onSuccess: (note) => {
      client.setQueryData(queryKeys.note(note.id), note);
      addNoteToTreeCache(client, userId, note);
      void client.invalidateQueries({ queryKey: TREE_KEY_PREFIX, refetchType: 'none' });
    },
  });
}
