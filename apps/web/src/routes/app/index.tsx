/**
 * `/app` — "no note selected" (docs/plans/mvp/MVP-12.md §4).
 *
 * PR-12 shipped this page with two views in one file: a **recent list** when nothing was open, and the open
 * note's **summary** when something was. PR-13 took the second half away, exactly as this file's own header
 * told the next reader to expect — `routes/app/note.$noteId.tsx` now owns a note's name, location, size and
 * dates, because that is where a note is read, and the tree navigates there instead of painting a summary
 * over here. What is left is the recent list, and it is still worth being its own route: `contentUpdatedAt`
 * ordering is what "where was I?" means in a notes app, and it is the shortest path from a cold load back
 * into your work — with no selection state to consult, the question "is a note open?" no longer exists on
 * this page at all.
 *
 * The `app-note-summary` / `app-note-facts` / `app-note-location` / `app-note-close` test ids moved with the
 * summary rather than being re-invented here, and `apps/web/e2e/{folders,notes}.spec.ts` assert through them
 * after a double-click on a row — which is the mechanism that keeps a later PR from quietly moving the facts
 * somewhere its clicks cannot reach.
 *
 * The empty state says what to do next rather than celebrating that there is nothing: §7 of PR-12 put the
 * new-note dialog in PR-15, so the folder tree and the server's `POST /api/notes` are the whole story, and
 * the honest sentence about an empty instance is that the first thing to make is a folder.
 */
import { withMd } from '@note-taker/contracts';
import { createFileRoute, Link } from '@tanstack/react-router';
import { breadcrumbFor, recentNotes } from '../../features/tree/tree.selectors';
import { formatInstant } from '../../lib/format';
import { useApp } from './route';

export const Route = createFileRoute('/app/')({
  component: AppHome,
});

function AppHome() {
  const { openNote, tree } = useApp();
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
