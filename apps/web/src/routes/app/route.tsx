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
 * open, and it travels in `AppContext`. PR-12 invented that fact in a `useState`: the tree called
 * `openNote(note)`, the layout remembered it, and `index.tsx` drew a summary — which was the whole of
 * "opening" a note in a build with no editor route. PR-13 added `note.$noteId.tsx`, so the same call now
 * *navigates*, and `openedNote` is read back out of the location instead of out of state. That move is why
 * the tree and the sidebar keep working untouched: they still call `openNote`, and the layout is still the
 * only place that knows what it means. It is also why a reload, a pasted link and PR-15's
 * "open it after creating it" all arrive at the same place with the sidebar highlighting the right row — a
 * `useState` could only ever answer for the session that set it. This router version has no outlet-context
 * hook, and `match.context` (route context, from `beforeLoad`/`loader`) is the wrong box for the surviving
 * pieces: that is per-navigation server state, and "which note is open" is per-render client state.
 */

import { withMd } from '@note-taker/contracts';
import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useMemo } from 'react';

import { AppShell, type TreeState } from '../../components/layout/AppShell';
import { failureMessage } from '../../features/auth/auth.api';
import { guardNavigation } from '../../features/auth/session';
import { SettingsEffects } from '../../features/settings/settings-effects';
import { useUserTree } from '../../features/tree/tree.queries';

export const Route = createFileRoute('/app')({
  beforeLoad: ({ location }) => guardNavigation(location.pathname),
  component: AppLayout,
});

/** The note the tree has open, or `null` — which is what "no note selected" means in §4's table. */
export interface OpenedNote {
  readonly id: string;
  /**
   * The name with its `.md` on, for chrome. Empty when the tree does not have the row yet — a note seconds
   * after PR-15 created it, or a deep link into a tree still being fetched. The editor page draws its own
   * title from the note row it fetched, so this never has to be a guess.
   */
  readonly name: string;
}

/** What the shell hands the pages inside it. */
export interface AppContextValue {
  readonly openedNote: OpenedNote | null;
  /**
   * Open a note, or stop pretending one is open (`null`).
   *
   * Since PR-13 this is a **navigation**, and the `openedNote` above is read back from where it lands. The
   * tree still hands in the `{ id, name }` pair PR-12 invented for it — the id is the only part a URL needs,
   * and the name is the part the tree already knew.
   */
  readonly openNote: (note: OpenedNote | null) => void;
  readonly tree: TreeState;
}

/** The editor route's prefix, as it appears in the address bar: `/app/note/<id>`. */
const NOTE_PATH_PREFIX = '/app/note/';

/**
 * Which note the location says is open.
 *
 * A hand-written parse rather than `useMatch`/`useMatchRoute`, and that is the smaller risk: the router's
 * matching hooks are typed against the *generated* tree, and `routeTree.gen.ts` is written by a plug-in
 * after this file is saved — so the version of this call that type-checks today is the one that names no
 * params. The shape is also two lines and asserted directly (`route.test.tsx`), including the two ways a
 * prefix match goes wrong: `/app/note/` with nothing after it, and a path with another segment in it.
 */
export function noteIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(NOTE_PATH_PREFIX)) return null;
  const id = pathname.slice(NOTE_PATH_PREFIX.length);
  if (id.length === 0 || id.includes('/')) return null;
  // The id went into the URL through `encodeURIComponent`; a malformed escape is a path nobody typed, and
  // the honest answer is the raw text rather than a crash in the middle of reading the address bar.
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
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
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

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

  // The URL is the selection. The row is only consulted for the name, and a row the tree does not have yet
  // costs the chrome its label for a moment — never a wrong note, because the id came from the address bar.
  const openedNote = useMemo<OpenedNote | null>(() => {
    const id = noteIdFromPath(pathname);
    if (id === null) return null;
    const row = treeQuery.data?.notes.find((note) => note.id === id);
    return { id, name: row === undefined ? '' : withMd(row.name) };
  }, [pathname, treeQuery.data]);

  const openNote = useCallback(
    (note: OpenedNote | null): void => {
      // `null` is "close it": the tree says that when a delete takes the opened note with it, and the only
      // honest way to say it now is to leave the note route. The name in the pair is not a lie to keep —
      // `openedNote` is read from the location, and the tree's copy of the name is stale the moment a rename
      // lands, which is the same reason PR-12 could not keep this in state.
      void navigate(
        note === null ? { to: '/app' } : { to: '/app/note/$noteId', params: { noteId: note.id } },
      );
    },
    [navigate],
  );

  const value = useMemo<AppContextValue>(
    () => ({ openedNote, openNote, tree }),
    [openedNote, openNote, tree],
  );

  return (
    <AppContext.Provider value={value}>
      {/* PR-16's app-wide effect: the stored theme, applied to `<html>` on every authed load. It lives
          here rather than in `routes/__root.tsx` because the root owns no furniture and because the
          value it reads is a signed-in user's row — a signed-out visitor has no settings row to
          follow, and `prefers-color-scheme` is the right answer for them (see
          `features/settings/settings-effects.tsx`). */}
      <SettingsEffects />
      <AppShell tree={tree} onOpenNote={openNote} openedNoteId={openedNote?.id ?? null}>
        <Outlet />
      </AppShell>
    </AppContext.Provider>
  );
}

/** Exported for the test that says the provider is what pages read. */
export { AppContext };
