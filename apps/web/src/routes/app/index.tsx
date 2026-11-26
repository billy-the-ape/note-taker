/**
 * `/app` — "no note selected" (docs/plans/mvp/MVP-12.md §4).
 *
 * Two views in one file, because they are the same question from two directions. With nothing open it is a
 * **recent list**: the notes `contentUpdatedAt` puts first, which is what "where was I?" means in a notes app
 * and the shortest path from a cold load back into your work. With something open it is that note's
 * **summary** — the name, where it lives, how big it is, when it last changed.
 *
 * That second view is deliberately not an editor. §7 puts the editor pane in PR-13 (CodeMirror, the toolbar
 * transforms, the preview, the byte counter); what is here is what PR-12 can honestly draw from the tree
 * response alone — and note `contentBytes`/`wordCount` come from the *metadata* row (plan §9.2 #12), so
 * saying how big a note is does not need a key or a decryption pass. When PR-13 adds
 * `routes/app/note.$noteId.tsx`, this page keeps the recent list and loses the summary; the tree's `Enter`
 * will navigate there instead of opening it here, which is the only reason this page knows what "open" means
 * at all.
 *
 * The empty state says what to do next rather than celebrating that there is nothing: §7 puts the new-note
 * dialog in PR-15, so today the folder tree and the server's `POST /api/notes` are the whole story, and the
 * honest sentence about an empty instance is that the first thing to make is a folder.
 */
import { withMd } from '@note-taker/contracts';
import { createFileRoute, Link } from '@tanstack/react-router';
import { breadcrumbFor, recentNotes } from '../../features/tree/tree.selectors';
import { useApp } from './route';

export const Route = createFileRoute('/app/')({
  component: AppHome,
});

function AppHome() {
  const { openedNote, openNote, tree } = useApp();
  const response = tree.response;

  if (tree.loading) {
    return (
      <div className="flex flex-col gap-3 p-6" data-testid="app-home-loading">
        <p className="text-sm text-ink-muted">Loading your notes…</p>
        <div aria-hidden className="flex flex-col gap-2">
          {[0, 1, 2].map((row) => (
            <span key={row} className="h-4 w-64 animate-pulse rounded bg-paper-2" />
          ))}
        </div>
      </div>
    );
  }

  if (tree.failed) {
    return (
      <div className="flex flex-col gap-3 p-6" data-testid="app-home-error">
        <h1 className="text-xl font-semibold text-ink">The list did not load</h1>
        <p className="text-sm text-danger">{tree.message ?? 'The API did not answer.'}</p>
        <p className="text-sm text-ink-muted">
          Nothing of yours is lost: this is the reading that failed. Retry from the status bar below, or
          reload once the API is up.
        </p>
      </div>
    );
  }

  if (openedNote !== null) {
    const note = response?.notes.find((candidate) => candidate.id === openedNote.id);
    // A row can go away under us — another tab, or the delete in this very sidebar — and a summary of a note
    // that is not in the tree would be a summary of a guess.
    if (note === undefined) {
      return (
        <div className="flex flex-col gap-3 p-6" data-testid="app-note-gone">
          <h1 className="text-xl font-semibold text-ink">That note is not here</h1>
          <p className="text-sm text-ink-muted">
            It is gone from the tree — deleted, or this is a different instance than the one it came from.
          </p>
          <button
            type="button"
            className="self-start rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-paper-2"
            onClick={() => openNote(null)}
            data-testid="app-note-gone-close"
          >
            Back to recent notes
          </button>
        </div>
      );
    }

    return (
      <article className="flex flex-col gap-4 p-6" data-testid="app-note-summary">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-ink">{withMd(note.name)}</h1>
          <p className="text-sm text-ink-muted" data-testid="app-note-location">
            {breadcrumbFor(response?.folders ?? [], note.folderId)}
          </p>
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm" data-testid="app-note-facts">
          <dt className="text-ink-muted">Words</dt>
          <dd className="text-ink">{note.wordCount}</dd>
          <dt className="text-ink-muted">Size</dt>
          <dd className="text-ink">{note.contentBytes} bytes</dd>
          <dt className="text-ink-muted">Last edited</dt>
          <dd className="text-ink">{formatInstant(note.contentUpdatedAt)}</dd>
          <dt className="text-ink-muted">Created</dt>
          <dd className="text-ink">{formatInstant(note.createdAt)}</dd>
        </dl>

        <p className="text-sm text-ink-muted" data-testid="app-note-no-editor">
          Editing is not part of this build — the note is listed here so the tree has somewhere to point.
        </p>

        <div>
          <button
            type="button"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-paper-2"
            onClick={() => openNote(null)}
            data-testid="app-note-close"
          >
            Close
          </button>
        </div>
      </article>
    );
  }

  const recent = recentNotes(response?.notes ?? []);

  if (recent.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-6" data-testid="app-home-empty">
        <h1 className="text-2xl font-semibold text-ink">Nothing written yet</h1>
        <p className="text-sm text-ink-muted">
          Make a folder in the tree on the left; a note lands at the top level until you give it somewhere to
          live.
        </p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 p-6" data-testid="app-home">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-ink">Recent notes</h1>
        <p className="text-sm text-ink-muted">
          The last things you edited. Pick one in the tree, or start from this list.
        </p>
      </header>

      <ul className="flex flex-col gap-1" data-testid="recent-notes">
        {recent.map((note) => (
          <li key={note.id}>
            <button
              type="button"
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => openNote({ id: note.id, name: withMd(note.name) })}
              data-testid={`recent-note-${note.id}`}
            >
              <span className="font-medium">{withMd(note.name)}</span>
              <span className="truncate text-xs text-ink-muted">
                {breadcrumbFor(response?.folders ?? [], note.folderId)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-ink-muted">
                {formatInstant(note.contentUpdatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-sm text-ink-muted">
        Settings arrive with PR-16. Until then the theme is the toggle in the top bar, and{' '}
        <Link to="/app" className="text-brand underline">
          here
        </Link>{' '}
        is home.
      </p>
    </section>
  );
}

/**
 * The one place a timestamp is turned into words.
 *
 * Deliberately not `toLocaleString`: that is a different string in every container's locale, and a test that
 * asserts "the note looks recent" against a date the CI image's `TZ` decides is not a test. This is the
 * machine-readable form, shortened to the day an operator scans for.
 */
function formatInstant(iso: string): string {
  return iso.slice(0, 10);
}
