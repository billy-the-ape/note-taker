/**
 * A browser-shaped stand-in for the half of the app PR-15 cannot see (docs/plans/mvp/MVP-15.md §6).
 *
 * **What is real here.** The dialog, its mutation, the `QueryClient`, the session provider, the router and
 * `fetch` are the application's own — `fetch` is stubbed at the global, so the CSRF wrapper and the contract
 * schemas still run, exactly as `test/fakeApi.ts` has it for PR-08's forms.
 *
 * **What is a stand-in, and why one is needed.** PR-15's last acceptance criterion ends "the note is open in
 * the editor, focused, and the URL changed", and the editor route (`routes/app/note/$noteId.tsx`) is
 * **PR-13's file, which is not in this tree** — nor are PR-12's `/app` shell or its tree. So this harness
 * supplies the two things those PRs would otherwise own: a host page with the three triggers PR-12 wires
 * (`TopBar`, `StatusBar`, the tree context menu, which differ only in the `NewNoteTarget` they pass), and an
 * editor page that reads the `['note', id]` entry the create wrote and takes the caret when
 * `takesEditorFocus()` says this tab is the one that just created the note.
 *
 * `EditorPage` is therefore **PR-13's contract, executable**: when that route lands, the two lines that focus
 * a textarea and read the cache move into it and this file shrinks to the host. The assertion the harness
 * must keep — the focus handoff, the cache entry, the URL — belongs to PR-15 and does not go away with the
 * stub.
 *
 * The route tree is built here rather than imported from `routeTree.gen.ts` for the same reason: the
 * generated tree has no `/app/*` in it yet, and a test that navigated to a path it does not contain would be
 * asserting that the app 404s on a note, which is not what PR-15 promises anybody.
 */
import type { NoteWithContent, TreeResponse } from '@note-taker/contracts';
import { type QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { vi } from 'vitest';

import { useNewNoteDialog } from '../components/notes/NewNoteDialog';
import { SessionProvider } from '../features/auth/session';
import { takesEditorFocus } from '../features/notes/open-note';
import { createQueryClient, queryKeys } from '../lib/queryClient';
import type { FakeApi, Stub } from './fakeApi';
import { fakeApi, sessionUser } from './fakeApi';

/** The folder the harness's "selected folder" trigger passes as its target. */
export const HARNESS_FOLDER_ID = '019a3b4c-5d6e-7f81-8123-456789abcdef';
/** A note that already lives in that folder, so a collision has something to collide with. */
export const HARNESS_NOTE_ID = '019a3b4c-5d6e-7f82-8123-456789abcdef';
/** The id `createdReply()` hands back for the note a test is about to create. */
export const HARNESS_NEW_NOTE_ID = '019a3b4c-5d6e-7f83-8123-456789abcdef';
/** A clock frozen to the millisecond §6 names, so only `uniquify` can tell two prefills apart. */
export const HARNESS_MS = 1_700_000_000_000;

const STAMP = '2026-01-01T00:00:00.000Z';

/** A tree with one folder and one note in each place a new note can be aimed at. */
export function harnessTree(overrides: { readonly notes?: TreeResponse['notes'] } = {}): TreeResponse {
  return {
    folders: [{ id: HARNESS_FOLDER_ID, name: 'Ideas', parentId: null, createdAt: STAMP, updatedAt: STAMP }],
    notes: overrides.notes ?? [
      {
        id: HARNESS_NOTE_ID,
        name: 'todo',
        folderId: HARNESS_FOLDER_ID,
        version: 1,
        contentBytes: 3,
        wordCount: 1,
        contentUpdatedAt: STAMP,
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ],
  };
}

/**
 * `201` of `POST /api/notes` (§9.2 #16) — a whole `NoteWithContent`, because this client parses the body and
 * a shortcut here would be a failure that could never happen in a browser.
 */
export function createdReply(overrides: Partial<NoteWithContent> = {}): Stub {
  return () => ({
    status: 201,
    body: {
      id: HARNESS_NEW_NOTE_ID,
      name: `new-file-${HARNESS_MS}`,
      folderId: null,
      version: 1,
      contentBytes: 0,
      wordCount: 0,
      content: '',
      contentUpdatedAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
      ...overrides,
    },
  });
}

/** The shell's chrome: the three affordances PR-12 owns, and the dialog they open. It lives outside the
 * outlet, so creating a note and leaving the page does not take the button away with it. */
function NewNoteChrome() {
  const newNote = useNewNoteDialog();

  return (
    <div className="flex flex-col gap-3">
      {/* The `TopBar`/`StatusBar` case: nothing is selected, so no target, so the root. */}
      <button type="button" data-testid="open-new-note-root" onClick={() => newNote.openFor()}>
        New note
      </button>
      {/* The tree context menu's case: the row's folder, named, so the dialog can say where the note goes. */}
      <button
        type="button"
        data-testid="open-new-note-folder"
        onClick={() => newNote.openFor({ folderId: HARNESS_FOLDER_ID, folderName: 'Ideas' })}
      >
        New note in Ideas
      </button>
      {/* The same thing as a `role="menuitem"`, which is what a context-menu row really is. */}
      <button
        type="button"
        role="menuitem"
        data-testid="open-new-note-menuitem"
        onClick={() => newNote.openFor({ folderId: HARNESS_FOLDER_ID, folderName: 'Ideas' })}
      >
        New note (menu)
      </button>
      {newNote.dialog}
    </div>
  );
}

/**
 * PR-13's editor page, as far as PR-15 is concerned: read the row the create cached, and take the caret when
 * this tab is the one that just created the note. Both halves are the contract PR-13 implements for real.
 */
function EditorPage() {
  const { noteId } = EditorRoute.useParams();
  const client = useQueryClient();
  const wantsFocus = takesEditorFocus(client, noteId);
  const note = client.getQueryData<NoteWithContent>(queryKeys.note(noteId));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (wantsFocus) textareaRef.current?.focus();
  }, [wantsFocus]);

  return (
    <section data-testid="editor-page" data-note-id={noteId} data-wants-focus={String(wantsFocus)}>
      <p data-testid="editor-note-name">{note?.name ?? ''}</p>
      <textarea
        aria-label="note content"
        data-testid="editor"
        defaultValue={note?.content ?? ''}
        ref={textareaRef}
      />
    </section>
  );
}

const HarnessRoute = createRootRoute({
  component: () => (
    // `SessionProvider` here rather than in each page, which is what `routes/__root.tsx` does: the dialog
    // reads the session for the tree cache key, and a harness without the provider would be testing a
    // component that cannot mount in the real app.
    <SessionProvider>
      {/* The triggers live outside the outlet, because that is where a shell's chrome lives: creating a note
          leaves the page it started on, and the button has to survive it. */}
      <div className="flex flex-col gap-3">
        <NewNoteChrome />
        <Outlet />
      </div>
    </SessionProvider>
  ),
});

/** The page the app boots on. Deliberately not the chrome: a component rendered twice would give every
 * `data-testid` two matches, which is the mistake this file made once already. */
function HomePage() {
  return <p data-testid="home-page">No note is open.</p>;
}

const HomePageRoute = createRoute({ getParentRoute: () => HarnessRoute, path: '/', component: HomePage });

const EditorRoute = createRoute({
  getParentRoute: () => HarnessRoute,
  path: '/app/note/$noteId',
  component: EditorPage,
});

const harnessRouteTree = HarnessRoute.addChildren([HomePageRoute, EditorRoute]);

export interface HarnessOptions {
  /** Extra routes for `fakeApi`, e.g. `{ 'POST /api/notes': createdReply() }`. */
  readonly routes?: Readonly<Record<string, Stub>>;
  /** What `['tree', userId]` holds when the app boots. Defaults to {@link harnessTree}; `null` means "no tree yet". */
  readonly tree?: TreeResponse | null;
  /** The session. `null` is a signed-out browser, which is the case the dialog must not fall over on. */
  readonly user?: ReturnType<typeof sessionUser> | null;
  readonly client?: QueryClient;
  readonly path?: string;
}

/**
 * Boots the app at `path` with a seeded tree and a stubbed `fetch`.
 *
 * The seed is a seed rather than a stub: `['tree', userId]` is what §5 says uniqueness is checked against,
 * and the honest way to test that is to put a tree in the cache the way PR-12's query would, not to intercept
 * a `GET /api/tree` the dialog is forbidden from sending. If it ever did send one, `fakeApi`'s default
 * `500 INTERNAL` says so loudly.
 */
export async function bootNewNoteHarness(options: HarnessOptions = {}) {
  const client = options.client ?? createQueryClient();
  const user = options.user === undefined ? sessionUser() : options.user;

  client.setQueryData(queryKeys.authStatus, { needsSetup: false, registrationOpen: false });
  client.setQueryData(
    queryKeys.authSession,
    user === null ? { user: null } : { user, expiresAt: '2999-01-01T00:00:00.000Z' },
  );
  // A signed-out browser has no tree to cache, whichever way it was asked for.
  if (options.tree !== null && user !== null) {
    client.setQueryData(queryKeys.tree(user.id), options.tree ?? harnessTree());
  }

  const fake = fakeApi({ ...options.routes });
  vi.stubGlobal('fetch', fake.fetch);

  const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
  const router = createRouter({ routeTree: harnessRouteTree, history });

  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  // The first navigation is async in this router exactly as it is in `renderApp`, and until it settles
  // there is nothing on screen to click. Waiting for the shell's own chrome says "the host page painted",
  // which is the precondition every spec file here is about to rely on.
  await screen.findByTestId('open-new-note-root');

  return { client, fake, router, user: userEvent.setup(), ...view };
}

/** The body of every `POST /api/notes` the fake recorded, in the order they were sent. */
export function noteCreates(
  fake: FakeApi,
): readonly { readonly name?: string; readonly folderId?: string | null }[] {
  return fake.calls
    .filter((call) => call.method === 'POST' && call.path === '/api/notes')
    .map((call) => call.body as { readonly name?: string; readonly folderId?: string | null });
}
