/**
 * The strip along the bottom (docs/plans/mvp/MVP-12.md §4): what the tree knows right now, in one line.
 *
 * A status bar exists because the alternative is a screen that changes without telling you. Three states and
 * nothing else — loading (the first `GET /api/tree` is on its way), ready (the counts, which is the one number
 * that says whether your note is missing or the sidebar is scrolled), and error, which carries the server's
 * sentence and the retry. PR-14 puts the save state here too, which is why `busy` is a prop rather than an
 * assumption that the only slow thing in the app is the first load.
 *
 * It is a `role="status"` live region, so a change here is announced without stealing focus — which is exactly
 * the property a strip at the bottom of the screen should have, and the reason the counts are *not* in a
 * heading.
 */

import type { TreeResponse } from '@note-taker/contracts';
import { countNodes } from '../../features/tree/tree.selectors';
import { Spinner } from '../ui/Spinner';

export interface StatusBarProps {
  readonly response: TreeResponse | undefined;
  /** The tree query is in flight for the first time. */
  readonly loading: boolean;
  readonly failed: boolean;
  /** Any mutation is in flight: the optimistic tree is a preview, and a preview should say so. */
  readonly busy: boolean;
  /** The server's own words, when `failed`. */
  readonly message?: string | undefined;
}

export function StatusBar({ response, loading, failed, busy, message }: StatusBarProps) {
  return (
    <footer
      className="flex min-h-8 items-center gap-3 border-t border-line bg-surface px-3 text-xs text-ink-muted"
      data-testid="statusbar"
      role="status"
    >
      <span data-testid="statusbar-state">
        {failed
          ? (message ?? 'the tree could not be loaded')
          : loading
            ? 'loading the tree…'
            : counts(response)}
      </span>
      <span className="flex-1" />
      {/* The keyboard surface is small enough to state once, and this is the only place it is stated: §5's
          "everything reachable by keyboard" is a claim a person should be able to check without reading the
          source. */}
      <span className="hidden gap-2 sm:flex" data-testid="statusbar-keys">
        <kbd className="rounded border border-line px-1">↑↓</kbd>
        <kbd className="rounded border border-line px-1">←→</kbd>
        <kbd className="rounded border border-line px-1">Enter</kbd>
        <kbd className="rounded border border-line px-1">F2</kbd>
        <kbd className="rounded border border-line px-1">Del</kbd>
      </span>
      {busy ? <Spinner label="Saving" size="sm" /> : null}
    </footer>
  );
}

/** `3 folders · 12 notes`, in the same words the sidebar's own counter uses. */
function counts(response: TreeResponse | undefined): string {
  if (response === undefined) return 'nothing loaded yet';
  const { folders, notes } = countNodes(response);
  const folderWords = `${folders} ${folders === 1 ? 'folder' : 'folders'}`;
  const noteWords = `${notes} ${notes === 1 ? 'note' : 'notes'}`;
  return `${folderWords} · ${noteWords}`;
}
