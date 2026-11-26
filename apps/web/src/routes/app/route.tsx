/**
 * `/app` — the layout route every authed page renders into (docs/plans/mvp/MVP-12.md §4).
 *
 * `route.tsx` inside a directory is TanStack Router's file-based convention for a layout: this file wraps
 * `index.tsx` and the routes that follow it (`note.$noteId.tsx` in PR-13, `settings.tsx` in PR-16,
 * `search.tsx` in PR-17). `__layout.tsx` is the Next.js habit and the plug-in does not pick it up, which is
 * worth writing down once because the wrong file name here fails *silently* — the routes would still render,
 * just without the shell or the guard.
 *
 * **The guard lives here.** §4's table runs in `beforeLoad`, which is not a React render and cannot read a
 * context, so it reads the same two `QueryClient` entries the session provider does —
 * `features/auth/session.tsx` explains why it has to be that way. The root route runs the same table one
 * moment earlier for every URL in the app, including this one; that is not duplicated work (`ensureQueryData`
 * shares the pair of requests between guard and provider), and the duplication that matters — one guard per
 * page — is the thing this file exists to make impossible. A page under `/app` cannot be signed-out-visible,
 * because there is no place left to forget the check.
 *
 * **This route owns the tree query.** `['tree', userId]` has three readers: the sidebar, the status bar, and
 * the recent list in `index.tsx`. A query started by a child is three readers of three cache entries, so it is
 * read once here and turned into a `TreeState` — a view model, not a query object, because a shell should not
 * have to know what `isPending` means for a fetch it did not start.
 *
 * **What the pages get.** The one fact a page needs and the layout does not have is which note the tree has
 * open, and it travels in `AppContext`: a plain React provider around `<Outlet/>`. This router version has no
 * outlet-context hook, and `match.context` (route context, from `beforeLoad`/`loader`) is the wrong box for
 * it — that is per-navigation server state, and "which note is open" is per-render client state that changes
 * without a navigation.
 */
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useState } from 'react';

import { AppShell, type TreeState } from '../../components/layout/AppShell';
import { failureMessage } from '../../features/auth/auth.api';
import { guardNavigation } from '../../features/auth/session';
import { useUserTree } from '../../features/tree/tree.queries';

export const Route = createFileRoute('/app')({
  beforeLoad: ({ location }) => guardNavigation(location.pathname),
  component: AppLayout,
});

/** The note the tree has open, or `null` — which is what "no note selected" means in §4's table. */
export interface OpenedNote {
  readonly id: string;
  readonly name: string;
}

/** What the shell hands the pages inside it. */
export interface AppContextValue {
  readonly openedNote: OpenedNote | null;
  /** The tree calls this on `Enter`; PR-13's route will say the same thing with a URL instead. */
  readonly openNote: (note: OpenedNote | null) => void;
  readonly tree: TreeState;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * The `/app` layout's state, from a page inside it.
 *
 * It throws rather than returning `null` on the same reasoning as `useToast()`: the only way to reach this
 * hook is from a component the layout renders, so a `null` here is a routing mistake, and a page that
 * silently renders an empty state hides it.
 */
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error('useApp() must be used inside routes/app/* (see routes/app/route.tsx)');
  }
  return value;
}

function AppLayout() {
  const treeQuery = useUserTree();
  const [openedNote, setOpenedNote] = useState<OpenedNote | null>(null);

  const tree: TreeState = useMemo(
    () => ({
      response: treeQuery.data,
      loading: treeQuery.isPending,
      failed: treeQuery.isError,
      message: treeQuery.isError ? failureMessage(treeQuery.error) : undefined,
      // Not "a mutation is in flight": this route does not own the mutations — the tree in the sidebar does —
      // and a status bar that claimed to know which of the two was working would be worse than one that
      // reports the fact it can see, which is that the cache is being re-read. That is what the end of a
      // mutation looks like from here.
      busy: treeQuery.isFetching,
      retry: () => {
        void treeQuery.refetch();
      },
    }),
    // The five query booleans below are what they are: primitives, recomputed per render, so `data` staying
    // referentially fresh is the only thing that can change this object.
    [
      treeQuery.data,
      treeQuery.isPending,
      treeQuery.isError,
      treeQuery.isFetching,
      treeQuery.error,
      treeQuery.refetch,
    ],
  );

  const value = useMemo<AppContextValue>(
    () => ({ openedNote, openNote: setOpenedNote, tree }),
    [openedNote, tree],
  );

  return (
    <AppContext.Provider value={value}>
      <AppShell tree={tree} onOpenNote={setOpenedNote}>
        <Outlet />
      </AppShell>
    </AppContext.Provider>
  );
}

/** Exported for the test that says the provider is what pages read. */
export { AppContext };
