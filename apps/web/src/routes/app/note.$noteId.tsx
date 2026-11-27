/**
 * The note editor — PR-13 (`docs/plans/mvp/MVP-13.md`).
 *
 * ## What this file owns is a wiring order, not a component
 *
 * Almost every piece of the surface already existed with its own tests: the buffer and its save machine
 * (`useAutosave`, PR-14), the four editor-state components (PR-14), the tree and its sidebar (PR-12), the
 * new-note flow that wants to land here with a caret (PR-15), and the mode/transform/size helpers this page
 * composes (`lib/markdown.ts`, `lib/editorMode.ts`, `lib/note-size.ts`). What was missing — and what PR-19
 * had to leave `test.fixme` — is the route that holds them in the right order. Four orderings are the file,
 * and the rest is layout.
 *
 * **1. Nothing renders an editor until the row is in hand.** `useAutosave` is created *per note id*, from
 * `content` and `version`, and a machine built from `''` and `0` would own an empty buffer that the loaded
 * note then has to overwrite — while `useAutosave`'s own "follow the server when clean" effect is busy
 * adopting the real row. `NoteEditor` is a child component so the hook is not called until there is a row to
 * call it with, and the loading/error states are the page's, above it. The `key={noteId}` on the child is
 * what makes a note switch a *new* view over the previous note's machine rather than a reuse of it.
 *
 * **2. The editor renders `snapshot.buffer` and nothing else.** Not the query's `content`, not local state:
 * AGENTS.md states that rule for PR-14's benefit and it is exactly as binding here. `snapshot.version` is
 * the other half — the header quotes it, so nothing on the page can name a `baseVersion` the machine is not
 * currently holding, which matters because the conflict banner and the version line are read by the same
 * person during the same argument.
 *
 * **3. The note's *facts* come from the row, and the note's *text* comes from the machine.** `Words`,
 * `Size`, `Last edited` and `Created` are metadata the server computes without a key (plan §9.2 #12/#17), so
 * the header can be honest before a body is decrypted — which is why the facts are on screen while the pane
 * below still says "Opening note…". It is also why PR-12's `app-note-facts` block moved here rather than
 * being re-derived: it is the same four numbers, in the same markup, on the page where a note is read.
 *
 * **4. A dirty buffer is flushed before the page lets you leave it.** `useNavigationGuard` (this PR) blocks
 * client-side navigations — the sidebar's rows, the breadcrumbs, PR-12's recent list, all of which call
 * `openNote` and therefore *navigate* now — and refuses to own the unload path, which PR-14 owns
 * (`enableBeforeUnload: false` there). See that file for the Save/Discard/Stay semantics.
 *
 * ## The note summary moved here from `/app`
 *
 * `routes/app/index.tsx` used to render a note's name, location and size, because in PR-12's build a tree row
 * click could only set `openedNote` and there was nowhere else for that fact to go. Its own header said what
 * would happen when this route landed, and this is that: the index kept the recent list, and the four test
 * ids — `app-note-summary`, `app-note-location`, `app-note-facts`, `app-note-close` — came here with it.
 * `apps/web/e2e/folders.spec.ts` (a move, then "ask the app where the note is") and
 * `apps/web/e2e/notes.spec.ts` (a reload, then "is the body still mine") both arrive here through a
 * double-click on a row, so the ids stayed put and the specs kept their meaning instead of being edited to
 * fit the new page.
 *
 * ## `note-title` is a heading, not an input
 *
 * §5 wrote "an editable title field (`data-testid=\"note-title\"`)", and §4 is the reason it is not: the tree
 * owns rename (PR-12's row menu and `RenameDialog`), and AGENTS.md's one-renderer rule says a second input
 * writing the same row on one screen is the bug, not the feature. The acceptance criterion is
 * "`note-title` shows the renamed note in the tree without a reload" — that is one name, two renderers, and
 * one cache entry (`['tree', userId]`), which is what a heading reading the row gives. An input here would
 * have had to *invalidate the tree* to satisfy the same criterion, and would have sat next to a tree row that
 * is already being renamed.
 */

import { withMd } from '@note-taker/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ConflictBanner, DeletedNoteBanner } from '../../components/editor/ConflictBanner';
import { DraftPrompt } from '../../components/editor/DraftPrompt';
import { EditorPane } from '../../components/editor/EditorPane';
import { SaveStatus } from '../../components/editor/SaveStatus';
import { useNote } from '../../features/notes/note.queries';
import { takesEditorFocus } from '../../features/notes/open-note';
import { useAutosave } from '../../features/notes/useAutosave';
import {
  NAVIGATION_GUARD_ACTIONS,
  NAVIGATION_GUARD_TEST_ID,
  navigationGuardActionTestId,
  useNavigationGuard,
} from '../../features/notes/useNavigationGuard';
import { breadcrumbFor } from '../../features/tree/tree.selectors';
import { ApiError } from '../../lib/api';
import { clearDraftIf } from '../../lib/draft';
import { formatInstant } from '../../lib/format';
import { useApp } from './route';

export const Route = createFileRoute('/app/note/$noteId')({
  component: NoteEditorPage,
});

function NoteEditorPage() {
  const { noteId } = Route.useParams();
  const note = useNote(noteId);
  const client = useQueryClient();

  // PR-15's "after create, the note is open in the editor, **focused**". Read once, on mount, against the id
  // in the path: the intent entry is a fact about the tab, and `takesEditorFocus` is deliberately a *read*
  // rather than a consume, because `main.tsx`'s StrictMode double mount would eat a one-shot and the caret
  // would appear in production and not in tests, or the other way round.
  const [focusOnMount] = useState(() => takesEditorFocus(client, noteId));

  // Two different blank pages. PR-16's rule from `/app/settings` applies verbatim: gate on
  // `isError && !hasData`, never on `isError`, because a background refetch that fails while the row is on
  // screen means "this may be stale", not "there is nothing here" — and the second is a reason to throw
  // away a screen someone is typing into.
  if (note.isError && note.data === undefined) {
    return <EditorProblem noteId={noteId} error={note.error} retry={() => void note.refetch()} />;
  }
  if (note.data === undefined) {
    return (
      <div
        className="flex h-full flex-col gap-3 p-6"
        data-testid="editor-loading"
        // The id in the attribute, not prose in the card: a load that never lands is a debugging session,
        // and the one fact worth having is which of the two possibilities — a wrong id in the URL, or a
        // request that is not answering — the page is looking at.
        data-note-id={noteId}
      >
        <p className="text-sm text-ink-muted">Opening note…</p>
        <div aria-hidden className="flex flex-1 gap-3">
          <span className="h-full w-1/2 animate-pulse rounded-md bg-paper-2" />
          <span className="h-full w-1/2 animate-pulse rounded-md bg-paper-2" />
        </div>
      </div>
    );
  }

  return <NoteEditor key={noteId} note={note.data} focusOnMount={focusOnMount} />;
}

/**
 * The failed-load half: the §9.1 envelope's prose, and the two different next asks.
 *
 * `404` is *this note is gone* and the honest exit is the folder it is not in any more; anything else is
 * *nobody answered*, where reloading the whole page would lose the URL the person is standing on and
 * retrying the read is the only thing that can help.
 */
function EditorProblem({
  noteId,
  error,
  retry,
}: {
  readonly noteId: string;
  readonly error: unknown;
  readonly retry: () => void;
}) {
  const { openNote } = useApp();
  const status = error instanceof ApiError ? error.status : undefined;
  const gone = status === 404;
  const detail = error instanceof ApiError ? error.message : 'Nobody answered the request.';

  return (
    <div className="flex h-full items-start justify-center p-6" data-testid="editor-error" data-gone={gone}>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-4 shadow-card">
        <h1 className="text-lg font-semibold text-ink" data-testid="editor-error-title">
          {gone ? 'That note is not here' : 'The note did not load'}
        </h1>
        <p className="mt-1 text-sm text-ink-muted" data-testid="editor-error-message">
          {gone
            ? 'It is gone from the server — deleted, or this database is not the one it came from.'
            : detail}
        </p>
        <p className="mt-2 break-all font-mono text-xs text-ink-muted">{noteId}</p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => openNote(null)}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-paper-2"
            data-testid="editor-error-back"
          >
            Back to the folder
          </button>
          {gone ? null : (
            <button
              type="button"
              onClick={retry}
              className="rounded-md border border-brand bg-brand px-3 py-1.5 text-sm text-white hover:opacity-90"
              data-testid="editor-error-retry"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteEditor({
  note,
  focusOnMount,
}: {
  readonly note: import('@note-taker/contracts').NoteWithContent;
  readonly focusOnMount: boolean;
}) {
  const { tree, openNote } = useApp();
  const autosave = useAutosave({
    id: note.id,
    content: note.content,
    version: note.version,
    folderId: note.folderId,
  });
  const { snapshot, machine, draft } = autosave;

  // §5's dirty guard. The three answers are the machine's own operations: `saveNow` (flush, then go),
  // `adopt` (make the buffer the row's truth, so the unmount flush that follows has nothing to write), and
  // nothing at all (stay). The draft mirror is the half `adopt` cannot see, and clearing it is conditional
  // for PR-14's reason: another tab may have written a newer paragraph into that key in the meantime, and a
  // "Discard" that deletes it is data loss with a nicer name.
  const guard = useNavigationGuard({
    dirty: snapshot.dirty,
    onSave: () => {
      autosave.saveNow();
    },
    onDiscard: () => {
      const abandoned = machine.getBuffer();
      machine.adopt(note.content, note.version);
      clearDraftIf(note.id, abandoned);
    },
  });

  /**
   * The row, from whichever cache is further ahead.
   *
   * Two entries describe this note: `['note', id]` (the plaintext, refreshed by every save through
   * `syncSavedNote`) and the row inside `['tree', userId]` (refreshed by PR-12's rename, move and delete).
   * Reading only the first would freeze this heading against a rename — and the acceptance criterion is
   * "`note-title` shows the **re**named note in the tree without a reload", which a heading bound to the
   * note cache cannot show, because renaming a note never touches its plaintext or its `version`. It is
   * also the one-renderer rule from the other side: the name has one writer (the tree) and this page reads
   * the entry that writer invalidated, rather than keeping a copy of its own.
   *
   * `updatedAt` is the tiebreak because it is the column *both* writes bump (a content write and a rename
   * both move it; a rotation deliberately never does, PR-06). Ties go to the note row, which is the one
   * that knows where the note lives *and* what it says.
   */
  const row = tree.response?.notes.find((candidate) => candidate.id === note.id);
  const current = row !== undefined && row.updatedAt > note.updatedAt ? row : note;

  // The breadcrumb is tree data twice over: the note query says *which* folder, and only the tree knows
  // what that folder is called, what its parents are, and — after a move — which one it is in now. An
  // empty folder list is not an error, it is the tree not having arrived on a deep link, and the honest
  // sentence then is the one `breadcrumbFor` already gives.
  const location = useMemo(
    () => breadcrumbFor(tree.response?.folders ?? [], current.folderId),
    [tree.response, current.folderId],
  );

  const deleted = snapshot.failure?.kind === 'deleted';
  const versionLine = snapshot.dirty
    ? `v${snapshot.version} · unsaved changes`
    : `writing against v${snapshot.version}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:p-6" data-testid="note-editor">
      <header className="flex flex-col gap-1" data-testid="app-note-summary">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* §5's "title field", deliberately not a field: the tree owns rename (PR-12's row menu and
              `RenameDialog`) and this heading reads the same cache entry it writes, which is the whole of
              "shows the renamed note **without a reload**". A second input on this screen would be the
              one-renderer bug AGENTS.md names. */}
          <h1 className="text-2xl font-semibold text-ink" data-testid="note-title">
            {withMd(current.name)}
          </h1>
          {/* `toHaveText('Archive')` in `e2e/folders.spec.ts` is the reason this element's text is the
              breadcrumb and nothing else — no "in " prefix, no separator around the note's own name. */}
          <nav aria-label="Note location" className="text-sm text-ink-muted" data-testid="app-note-location">
            {location}
          </nav>
          <span className="flex-1" />
          <SaveStatus snapshot={snapshot} autosave={autosave.autosave} />
          <button
            type="button"
            onClick={() => openNote(null)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-muted hover:bg-paper-2 hover:text-ink"
            data-testid="app-note-close"
            aria-label="Close this note"
          >
            Close
          </button>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted" data-testid="app-note-facts">
          <div className="flex gap-1">
            <dt>Words</dt>
            <dd className="text-ink" data-testid="note-words">
              {current.wordCount}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Size</dt>
            {/* The raw number and the words: `notes.spec.ts` asserts `${Buffer.byteLength(body)} bytes` after a
                reload, and an abbreviation is a fact about the display, not about the body. */}
            <dd className="text-ink" data-testid="note-bytes">
              {current.contentBytes} bytes
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Last edited</dt>
            <dd className="text-ink">{formatInstant(current.contentUpdatedAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Created</dt>
            <dd className="text-ink">{formatInstant(current.createdAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Version</dt>
            {/* The number the next request will name as its `baseVersion`, from the machine rather than from
                the row: after a write the row's copy is the *server's* truth and this is *ours*. */}
            <dd className="text-ink" data-testid="note-version">
              {versionLine}
            </dd>
          </div>
        </dl>
      </header>

      {draft.content === undefined ? null : (
        <DraftPrompt content={draft.content} onRestore={draft.restore} onDiscard={draft.discard} />
      )}
      {snapshot.conflict === undefined ? null : (
        <ConflictBanner
          serverVersion={snapshot.conflict.serverVersion}
          serverContent={snapshot.conflict.serverContent}
          onKeepMine={autosave.resolveKeepMine}
          onUseServer={autosave.resolveUseServer}
        />
      )}
      {deleted ? (
        <DeletedNoteBanner
          reason={snapshot.failure?.message}
          onSaveAsNewNote={async () => {
            const created = await autosave.saveAsNewNote();
            // The tree invalidation is PR-14's (`saveAsNewNote` does it); navigating through `openNote` keeps
            // the URL the single source of "which note is open" that `routes/app/route.tsx` just argued for.
            openNote({ id: created.id, name: withMd(created.name) });
          }}
        />
      ) : null}

      {/* The pane is disabled-looking rather than hidden when the machine has stopped: `deleted` means the
          text is real and unsavable, and a buffer you cannot read is the worse answer. */}
      <EditorPane
        buffer={snapshot.buffer}
        onEdit={autosave.edit}
        focusOnMount={focusOnMount}
        className="min-h-0 flex-1"
      />

      {guard.blocked ? (
        // The overlay rather than a route, because §5's "Stay" has to leave the caret exactly where it was
        // and a navigation is how you get here in the first place. `aria-modal` + a labelled dialog: it is a
        // decision with three answers and no fourth, and it is read by a screen reader before it is clicked.
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unsaved-prompt-heading"
          data-testid={NAVIGATION_GUARD_TEST_ID}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-card">
            <h2 id="unsaved-prompt-heading" className="text-sm font-semibold text-ink">
              This note has changes that are not saved.
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              Saving writes them before the page moves. Discarding leaves the note as the server has it — the
              text in this buffer is gone from this browser too.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {NAVIGATION_GUARD_ACTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  data-testid={navigationGuardActionTestId(action)}
                  onClick={action === 'save' ? guard.save : action === 'discard' ? guard.discard : guard.stay}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    action === 'stay'
                      ? 'border border-line bg-surface text-ink hover:bg-paper-2'
                      : 'border border-brand bg-brand text-white hover:opacity-90'
                  }`}
                >
                  {action === 'save' ? 'Save' : action === 'discard' ? 'Discard' : 'Stay'}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {/* A `deleted` machine is still an editor: the text stays readable and the banner is the way out, so
          nothing here is `readOnly` — §4's `404` row keeps the buffer for the new note it is offering. */}
      {snapshot.stopped ? <span className="sr-only">Autosave has stopped for this note.</span> : null}
    </div>
  );
}
