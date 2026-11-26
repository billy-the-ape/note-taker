/**
 * The `/app` chrome (docs/plans/mvp/MVP-12.md §4): the top bar, the sidebar, the pane in the middle, and the
 * status strip — and nothing else. No fetching, no routing, no state.
 *
 * Why the shell is presentational is the layout: the tree query has three readers (the sidebar, the status
 * bar, and the recent list `routes/app/index.tsx` shows when nothing is open), and a query owned by a child
 * is three readers of three different cache entries. So the `/app` layout route reads `['tree', userId]`
 * once, hands one `TreeState` down, and this component decides where things go on a screen.
 *
 * The grid is `grid-cols-[auto_1fr]` with the sidebar at a fixed `clamp` width: a self-hosted notes app gets
 * a 13-inch laptop and a 27-inch monitor, and a sidebar that takes 25% of one is unreadably narrow while 25%
 * of the other is a wall of whitespace. `min-w-0` on the main pane is the difference between a long note
 * title resizing the window and one that truncates where it is told to.
 *
 * A **skip link** is the first focusable thing on the page. The tree is one tab stop, so keyboard travel from
 * the sidebar to the editor is short — but "short" is still twice the distance of "there is a link that says
 * Skip to the note", and it is what a screen-reader user gets instead of tabbing through a header they have
 * heard four times.
 */
import type { TreeResponse } from '@note-taker/contracts';
import type { ReactNode } from 'react';

import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

/**
 * What the layout route knows about the tree, in one object.
 *
 * It is a *view model* rather than a TanStack Query result: the shell should not have to know what `isPending`
 * means for a query it did not start, and PR-13 will add a second query (`['note', id]`) whose states have
 * different names for the same three facts.
 */
export interface TreeState {
  readonly response: TreeResponse | undefined;
  /** No entry yet: the first `GET /api/tree` is on its way. */
  readonly loading: boolean;
  /** The query failed, and the server's words about it. */
  readonly failed: boolean;
  readonly message?: string | undefined;
  /** A mutation is in flight somewhere in the tree, so the status bar can say "Saving". */
  readonly busy: boolean;
  readonly retry: () => void;
}

export interface AppShellProps {
  readonly tree: TreeState;
  readonly onOpenNote?: (note: { readonly id: string; readonly name: string } | null) => void;
  /**
   * The note the page is reading, handed to the sidebar because a delete there is the one thing that can take
   * it away (PR-12 review). The route owns the state; the shell only passes it to the half that decides.
   */
  readonly openedNoteId?: string | null | undefined;
  readonly children: ReactNode;
}

export function AppShell({ tree, onOpenNote, openedNoteId = null, children }: AppShellProps) {
  return (
    <div className="flex h-dvh flex-col bg-paper text-ink" data-testid="app-shell">
      <TopBar />

      <a
        href="#app-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded
          focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
        data-testid="skip-to-main"
      >
        Skip to the note
      </a>

      <div className="grid min-h-0 flex-1 grid-cols-[clamp(16rem,22vw,22rem)_minmax(0,1fr)]">
        <Sidebar
          response={tree.response}
          loading={tree.loading}
          failed={tree.failed}
          message={tree.message}
          busy={tree.busy}
          onRetry={tree.retry}
          onOpenNote={onOpenNote}
          openedNoteId={openedNoteId}
        />

        <main id="app-main" className="min-w-0 overflow-y-auto" data-testid="app-main" tabIndex={-1}>
          {children}
        </main>
      </div>

      <StatusBar
        response={tree.response}
        loading={tree.loading}
        failed={tree.failed}
        busy={tree.busy}
        message={tree.message}
      />
    </div>
  );
}
