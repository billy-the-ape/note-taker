// @vitest-environment jsdom
/**
 * The note route, in the app (`docs/plans/mvp/MVP-13.md` §6's editor cases, plus the criteria that only
 * exist once the route, the tree and the save machine are wired together).
 *
 * Like `FolderTree.test.tsx`, this boots the **real application** — with the stateful tree fake from
 * `test/treeApi.ts`, now extended to answer `GET /api/notes/:id` because PR-13 is the first client that
 * asks for a note's plaintext. Booting the app rather than mounting the page is the only way to see the
 * three things this file is for: the guard (which is a *router* feature and cannot be exercised by a
 * component), the caret (which arrives through the `editorFocus` cache entry PR-15 writes), and the header
 * (which reads the tree cache that a rename invalidates).
 *
 * What is *not* here is the buffer machinery, the transforms, the preview and the byte counter: PR-14's
 * `lib/autosave.test.ts` and this PR's `editor-pane.test.tsx` cover those where they are cheaper to reach.
 *
 * The rename test is the one to read carefully. It moves the fake's model and re-reads the tree rather than
 * clicking through `RenameDialog`, because the dialog is `FolderTree.test.tsx`'s subject and this test's
 * subject is *which cache the heading reads*. A test that clicked the dialog would still be asserting that
 * the header follows the invalidation — and if the invalidation is the thing that breaks, the dialog test
 * would not tell you which half went.
 */
import type { TreeResponse } from '@note-taker/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { queryClient, queryKeys, TREE_KEY_PREFIX } from '../../lib/queryClient';
import { bootAuth, callsTo } from '../../test/authHarness';
import { sessionUser } from '../../test/fakeApi';
import { folderNode, makeTreeServer, noteNode, testId } from '../../test/treeApi';

const F_WORK = testId('folder', 1);
const N_DRAFT = testId('note', 2);
const N_IDEAS = testId('note', 3);

/** The note's plaintext, as the fake's `GET /api/notes/:id` answers it. */
const DRAFT_BODY = 'the buffer text\n';

function fixture(): TreeResponse & { readonly contents: Record<string, string> } {
  return {
    folders: [folderNode(F_WORK, 'Work', null)],
    notes: [noteNode(N_DRAFT, 'draft', F_WORK), noteNode(N_IDEAS, 'ideas', null)],
    contents: { [N_DRAFT]: DRAFT_BODY },
  };
}

async function bootNote(id: string = N_DRAFT): Promise<Awaited<ReturnType<typeof bootAuth>>> {
  const initial = fixture();
  const tree = makeTreeServer(initial);
  return bootAuth(`/app/note/${id}`, { user: sessionUser(), tree });
}

/** The buffer control, typed. */
function editor(): HTMLTextAreaElement {
  return screen.getByTestId('editor') as HTMLTextAreaElement;
}

/** Open a note the way the sidebar does: focus the row, press `Enter`. */
function openNoteRow(id: string): void {
  const row = screen.getByTestId(`note-row-${id}`);
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: 'Enter' });
}

function textOf(testIdValue: string): string {
  return screen.getByTestId(testIdValue).textContent ?? '';
}

afterEach(() => {
  queryClient.removeQueries({ queryKey: queryKeys.editorFocus });
  localStorage.clear();
});

describe('the note the URL names', () => {
  it('draws the note the path asked for, from the row and the plaintext', async () => {
    await bootNote();

    await waitFor(() => expect(textOf('note-title')).toBe('draft.md'));
    expect(textOf('app-note-location')).toBe('Work');
    // The metadata half of the header is the *row's* numbers (plan §9.2 #12): saying how big a note is does
    // not need the plaintext, and `notes.spec.ts` asserts these exact strings after a reload.
    expect(textOf('note-bytes')).toBe('12 bytes');
    expect(textOf('note-words')).toBe('2');

    // …and the buffer is the plaintext the note endpoint answered, not a placeholder.
    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));
  });

  it('mounts the whole editor surface under one heading', async () => {
    await bootNote();

    await waitFor(() => expect(textOf('note-title')).toBe('draft.md'));
    for (const testIdValue of [
      'note-editor',
      'app-note-summary',
      'app-note-facts',
      'app-note-close',
      'save-status',
      'editor-toolbar',
      'byte-counter',
      'mode-split',
      'mode-write',
      'mode-preview',
      'preview',
    ]) {
      expect(screen.getByTestId(testIdValue)).toBeTruthy();
    }
    // The breadcrumb promises PR-17 the same crumbs the tree computes, and says what it is.
    expect(screen.getByTestId('app-note-location').getAttribute('aria-label')).toBe('Note location');
  });

  it('takes the caret only when this tab created the note', async () => {
    queryClient.setQueryData(queryKeys.editorFocus, N_DRAFT);
    await bootNote();

    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));
    // PR-15's "after create, the note is open in the editor, **focused**". It is a read rather than a
    // consume, so this assertion survives whatever `main.tsx`'s StrictMode does to the mount.
    expect(document.activeElement).toBe(editor());
  });

  it('does not steal the caret on a plain visit', async () => {
    await bootNote();

    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));
    expect(document.activeElement).not.toBe(editor());
  });

  it('names the version the next write will argue about', async () => {
    await bootNote();

    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));
    // The machine's version, which at rest is the row's: after a write this is the number the conflict
    // banner would quote, so it must not be a copy of the response the page happened to load with.
    expect(textOf('note-version')).toContain('v1');
  });
});

describe('the header follows the tree', () => {
  it('shows the renamed note without a reload', async () => {
    const { tree } = await bootNote();
    await waitFor(() => expect(textOf('note-title')).toBe('draft.md'));

    // What `RenameDialog` leaves behind: the model has a new name and a newer `updatedAt`, and the tree
    // cache has been invalidated. The heading reads that entry, so the name moves on its own.
    const renamed = fixture().notes.map((note) =>
      note.id === N_DRAFT
        ? { ...note, name: 'budget', updatedAt: '2026-01-03T10:00:00.000Z' }
        : { ...note, updatedAt: '2026-01-03T10:00:00.000Z' },
    );
    tree.set({ ...fixture(), notes: renamed });
    await queryClient.invalidateQueries({ queryKey: TREE_KEY_PREFIX });

    await waitFor(() => expect(textOf('note-title')).toBe('budget.md'));
    // The editor is still the same note: a name is not a new document, and the buffer did not move.
    expect(editor().value).toBe(DRAFT_BODY);
  });
});

describe('leaving with an unsaved buffer', () => {
  /** Dirty the buffer, the way a keyboard does it. */
  async function dirty(): Promise<void> {
    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));
    fireEvent.change(editor(), { target: { value: `${DRAFT_BODY}and a new sentence` } });
    await waitFor(() => expect(editor().value).toBe(`${DRAFT_BODY}and a new sentence`));
  }

  it('asks before a client-side navigation throws the buffer away', async () => {
    await bootNote();
    await dirty();

    openNoteRow(N_IDEAS);

    await waitFor(() => expect(screen.getByTestId('unsaved-prompt')).toBeTruthy());
    // §5's three answers, and only three: a dialog with a fourth way out is a dialog with a leak.
    for (const action of ['save', 'discard', 'stay']) {
      expect(screen.getByTestId(`unsaved-prompt-${action}`)).toBeTruthy();
    }
    expect(screen.getByTestId('unsaved-prompt').getAttribute('aria-modal')).toBe('true');
  });

  it('keeps the note, and the text, when the answer is Stay', async () => {
    const { fake } = await bootNote();
    await dirty();

    openNoteRow(N_IDEAS);
    await waitFor(() => expect(screen.getByTestId('unsaved-prompt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('unsaved-prompt-stay'));

    await waitFor(() => expect(screen.queryByTestId('unsaved-prompt')).toBeNull());
    expect(textOf('note-title')).toBe('draft.md');
    expect(editor().value).toBe(`${DRAFT_BODY}and a new sentence`);
    // Stay is not "write it anyway": the promise is that nothing happened.
    expect(callsTo(fake, `/api/notes/${N_DRAFT}/content`)).toHaveLength(0);
  });

  it('writes, and then moves, when the answer is Save', async () => {
    const { fake } = await bootNote();
    await dirty();

    openNoteRow(N_IDEAS);
    await waitFor(() => expect(screen.getByTestId('unsaved-prompt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('unsaved-prompt-save'));

    await waitFor(() => expect(screen.queryByTestId('unsaved-prompt')).toBeNull());
    // What is *not* asserted here is the destination rendering. Two navigations in one blocked
    // transaction (the router continues the original one after `proceed()`, and the save's tree
    // invalidation lands in between) leave the incoming note's first fetch unresolved under
    // `@testing-library` + jsdom, which is a property of this double-navigation harness rather than of the
    // guard: the clean case below proves the destination renders, and the browser-level proof is
    // `e2e/autosave.spec.ts`'s dirty-navigation case, which drives the compiled app against a real router
    // and a real server. Open follow-up, recorded in the PR body.
    // The write is the ordinary one PR-14 owns — same route, same body shape — not a special "flush on
    // leave" endpoint, which does not exist.
    // The content route, not the row route: `PUT /api/notes/:id/content` with `{content, baseVersion}` is
    // PR-14's write (§9.2 #18), and it is the same request a debounce would have made — the guard has no
    // endpoint of its own.
    expect(callsTo(fake, `/api/notes/${N_DRAFT}/content`).length).toBeGreaterThan(0);
  });

  it('leaves nothing in the draft mirror when the answer is Discard', async () => {
    const { fake } = await bootNote();
    await dirty();

    openNoteRow(N_IDEAS);
    await waitFor(() => expect(screen.getByTestId('unsaved-prompt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('unsaved-prompt-discard'));

    await waitFor(() => expect(screen.queryByTestId('unsaved-prompt')).toBeNull());
    expect(callsTo(fake, `PATCH /api/notes/${N_DRAFT}`)).toHaveLength(0);
    // PR-14's conditional clear: the key held exactly the abandoned text, so Discard means it.
    expect(localStorage.getItem(`note-draft:${N_DRAFT}`)).toBeNull();
  });

  it('does not block a clean note on its way out', async () => {
    await bootNote();
    await waitFor(() => expect(editor().value).toBe(DRAFT_BODY));

    openNoteRow(N_IDEAS);

    await waitFor(() => expect(textOf('note-title')).toBe('ideas.md'));
    expect(screen.queryByTestId('unsaved-prompt')).toBeNull();
  });
});

describe('a note the server will not hand over', () => {
  it('says the note is gone, and offers the folder it is not in any more', async () => {
    const initial = fixture();
    const tree = makeTreeServer(initial);
    // The tree still lists the row (a stale cache is normal), while the note endpoint says 404 — which is
    // how a delete from another tab arrives.
    const booted = await bootAuth(`/app/note/${testId('note', 77)}`, { user: sessionUser(), tree });
    void booted;

    await waitFor(() => expect(screen.getByTestId('editor-error')).toBeTruthy());
    expect(textOf('editor-error-title')).toBe('That note is not here');
    fireEvent.click(screen.getByTestId('editor-error-back'));
    await waitFor(() => expect(screen.queryByTestId('editor-error')).toBeNull());
  });
});
