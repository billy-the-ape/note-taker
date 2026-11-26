/**
 * The sidebar: the tree, plus the three states around it (docs/plans/mvp/MVP-12.md §5 — "empty state; loading
 * skeletons; error toasts with retry").
 *
 * The split between this file and `FolderTree` is the split between *fetching* and *showing*: the query lives
 * one level up (the `/app` layout, so the status bar and the recent list read the same cache entry), and this
 * component's whole job is to answer "what does the tree look like when it is not there yet, or when it
 * failed?" That question has three honest answers and a component that ignores two of them is the reason a
 * slow database looks like a crash.
 *
 * **Loading** is a skeleton rather than a spinner because the tree's shape is known before its contents are:
 * five rows of the right height, indented as if, so nothing jumps when the rows arrive. **Failure** is a
 * message plus a Retry button rather than a toast, because a toast expires and a failed first load needs the
 * button to still be there when the person looks up. Mutation failures are the toast's business — they are
 * single events with a dialog in front of them — and §5's "error toasts with retry" is the pair of those two
 * halves, not one control doing both jobs.
 *
 * **Collapsed** is persisted in the `ui` store (`nt.sidebarCollapsed`): a self-hosted app on a laptop with a
 * 1024px screen spends a fair amount of time with the tree out of the way, and a preference about the chrome
 * is exactly what AGENTS.md says belongs there rather than in a store of its own.
 */

import type { TreeResponse } from '@note-taker/contracts';
import { useState } from 'react';
import { readUi, writeUi } from '../../lib/uiStore';
import { FolderTree } from '../tree/FolderTree';
import { Button } from '../ui/Button';

/** The `ui` store key holding the sidebar's collapse, named so a test can read what it asserts. */
export const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';

export interface SidebarProps {
  readonly response: TreeResponse | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  /** The server's own words about the failure, when there is one. */
  readonly message?: string | undefined;
  /** Any mutation is in flight: the tree is a preview of a request that has not been answered yet. */
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onOpenNote?: ((note: { readonly id: string; readonly name: string } | null) => void) | undefined;
}

export function Sidebar({ response, loading, failed, message, busy, onRetry, onOpenNote }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => readUi(SIDEBAR_COLLAPSED_KEY, '') === 'true');

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeUi(SIDEBAR_COLLAPSED_KEY, next ? 'true' : 'false');
  };

  return (
    <nav
      aria-label="Folders and notes"
      // No `aria-expanded` here: it is not a valid attribute for a `nav` landmark, and the state is already
      // said twice over — by the toggle's own label ("Show the folder tree" / "Hide the folder tree") and by
      // `data-collapsed`, which is what the UI tests select.
      aria-busy={busy}
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="flex h-full w-full flex-col gap-2 overflow-y-auto border-r border-line bg-paper py-2"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Tree</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label={collapsed ? 'Show the folder tree' : 'Hide the folder tree'}
          data-testid="sidebar-toggle"
        >
          {collapsed ? 'Show' : 'Hide'}
        </Button>
      </div>

      {collapsed ? null : failed ? (
        <div className="flex flex-col gap-2 px-2 py-3" data-testid="sidebar-error">
          <p className="text-sm text-danger">{message ?? 'The tree could not be loaded.'}</p>
          <p className="text-xs text-ink-muted">
            Your notes are still there — this is the list that failed, not the data.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            className="self-start"
            data-testid="tree-retry"
          >
            Try again
          </Button>
        </div>
      ) : loading ? (
        <TreeSkeleton />
      ) : (
        <FolderTree response={response ?? { folders: [], notes: [] }} onOpenNote={onOpenNote} />
      )}
    </nav>
  );
}

/**
 * Five rows of the shape the tree has, so the first paint does not move when the rows arrive.
 *
 * It is `aria-hidden`: a live region that announces "loading" and then a second that announces a list of
 * nothing-but-skeleton is two announcements for one fact, and the tree's own `role="tree"` says the real thing
 * when it exists.
 */
export function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-1 py-2" aria-hidden data-testid="tree-skeleton">
      {[0, 1, 2, 3, 4].map((row) => (
        <span
          key={row}
          className="h-4 animate-pulse rounded bg-paper-2"
          // The indentation of a hypothetical tree, which is the whole point of a skeleton: the shape of the
          // thing that is coming, at the size it will be.
          style={{ marginLeft: `${(row % 3) * 1}rem` }}
        />
      ))}
    </div>
  );
}
