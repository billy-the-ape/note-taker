// @vitest-environment jsdom
/**
 * The new-note dialog, end to end (docs/plans/mvp/MVP-15.md §6).
 *
 * Every test boots the real app through `test/new-note-harness.tsx`: the router, the session provider, the
 * query client, the CSRF wrapper around a stubbed `fetch`, and the contract schemas on the way in. Two
 * reasons that matters here more than in most suites: the criterion is about a *name arriving in a request
 * body* (`folderId: null` for the root, no `.md`, uniquified once), and about a navigation landing on a page
 * with the caret in it — both of which are properties of the whole path, not of a component.
 *
 * What is asserted as markup rather than as pixels: the suffix is a sibling of the input, so it cannot be
 * deleted (the `Input`'s value is the only thing a keyboard can reach); the field error is the contract's own
 * sentence; Create is a `disabled` attribute, not a click handler that quietly no-ops.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME_REJECTION_MESSAGES, type NameRejection, type TreeResponse } from '@note-taker/contracts';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queryClient';
import { errorBody, type Stub } from '../../test/fakeApi';
import {
  bootNewNoteHarness,
  createdReply,
  HARNESS_FOLDER_ID,
  HARNESS_MS,
  HARNESS_NEW_NOTE_ID,
  HARNESS_NOTE_ID,
  type HarnessOptions,
  harnessTree,
  noteCreates,
} from '../../test/new-note-harness';
import {
  NAME_CHECK_DEBOUNCE_MS,
  NAME_TAKEN_MESSAGE,
  NEW_NOTE_FIELD_ID,
  UNKNOWN_CREATE_FAILURE,
} from './NewNoteDialog';

/** The signed-in fixture's id, which is the half of `['tree', userId]` this test seeded. */
const USER_ID = '019a3b4c-5d6e-7f80-9123-456789abcdef';
const PREFILL = `new-file-${HARNESS_MS}`;

/** The one thing every test here wants that the harness does not default: a `POST /api/notes` that answers. */
function boot(options: HarnessOptions = {}) {
  return bootNewNoteHarness({ routes: { 'POST /api/notes': createdReply() }, ...options });
}

const field = () => screen.getByTestId<HTMLInputElement>(NEW_NOTE_FIELD_ID);
const createButton = () => screen.getByTestId<HTMLButtonElement>('new-note-create');
const suffix = () => screen.getByTestId('new-note-suffix');

beforeEach(() => {
  // §6's same-millisecond case is unprovable without this: two `Date.now()` reads have to agree.
  vi.spyOn(Date, 'now').mockReturnValue(HARNESS_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the prefill', () => {
  it('opens on new-file-<ms>.md with the caret before the .md', async () => {
    const { user } = await boot();
    await user.click(screen.getByTestId('open-new-note-root'));

    const input = field();
    // The value excludes the extension; the extension is the sibling after it. That split is the whole
    // mechanism, so both halves are asserted before the caret is worth mentioning.
    expect(input.value).toBe(PREFILL);
    expect(suffix().textContent).toBe('.md');
    expect(suffix().previousElementSibling).toBe(input);

    expect(document.activeElement).toBe(input);
    // "Before the `.md`" is "at the end of what the user owns": `setSelectionRange(value.length, …)`.
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('gives a second dialog opened in the same millisecond a name that is not taken', async () => {
    const { user } = await boot({ tree: harnessTree({ notes: [] }) });

    await user.click(screen.getByTestId('open-new-note-root'));
    expect(field().value).toBe(PREFILL);
    await user.click(createButton());
    await screen.findByTestId('editor-page');

    // Same clock, same folder, one more note in the cache: only `uniquify` can tell these two apart.
    await user.click(screen.getByTestId('open-new-note-root'));
    await waitFor(() => expect(field().value).toBe(`${PREFILL}-2`));
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(field().value.length);
  });
});

describe('the fixed .md suffix', () => {
  it('survives everything the keyboard can do to the input, and never reaches the body', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-root'));
    const input = field();

    await user.clear(input);
    expect(input.value).toBe('');
    expect(suffix().textContent).toBe('.md');

    await user.keyboard('{Backspace}');
    await user.keyboard('{Delete}');
    expect(input.value).toBe('');
    expect(suffix().textContent).toBe('.md');

    // Now type a name that *carries* an extension: the fixed suffix is still the only one the user sees, the
    // typed one is ordinary characters, and the body carries neither.
    await user.type(input, 'quarterly report.md');
    expect(input.value).toBe('quarterly report.md');
    expect(suffix().textContent).toBe('.md');

    await user.click(createButton());
    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]?.name).toBe('quarterly report');
    expect(noteCreates(fake)[0]?.name).not.toContain('.md');
  });
});

describe('live validation', () => {
  const refused: readonly [string, NameRejection][] = [
    ['', 'empty'],
    ['a/b', 'reserved-characters'],
    ['foo.md.md', 'nested-extension'],
    ['x'.repeat(121), 'too-long'],
    ['todo ', 'whitespace-padded'],
  ];

  it.each(refused)(
    'says what is wrong with %s, in the contract’s words, before anyone submits',
    async (typed, rejection) => {
      const { user, fake } = await boot();
      await user.click(screen.getByTestId('open-new-note-root'));

      await user.clear(field());
      if (typed.length > 0) await user.type(field(), typed);

      expect(await screen.findByText(NAME_REJECTION_MESSAGES[rejection])).toBeTruthy();
      // The message and the disabled button are the same fact twice, and both are required: `aria-invalid` is
      // what a screen reader announces, `disabled` is what stops the request.
      expect(field().getAttribute('aria-invalid')).toBe('true');
      expect(createButton().disabled).toBe(true);
      expect(noteCreates(fake)).toHaveLength(0);
    },
  );

  it('calls a name that is already a sibling by §4’s sentence, on the debounce, without a request', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-folder'));

    await user.clear(field());
    await user.type(field(), 'todo'); // `todo` is the note `harnessTree` keeps in that folder.
    // Not synchronously: the check is debounced, and `NAME_CHECK_DEBOUNCE_MS` is the promise that it is.
    expect(NAME_CHECK_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(screen.queryByText(NAME_TAKEN_MESSAGE)).toBeNull();

    expect(await screen.findByText(NAME_TAKEN_MESSAGE)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    expect(noteCreates(fake)).toHaveLength(0);
  });

  it('does not treat a folder of the same name as a taken note name', async () => {
    const { user } = await boot();
    await user.click(screen.getByTestId('open-new-note-folder'));
    await user.clear(field());
    await user.type(field(), 'Ideas');
    await waitFor(() => expect(screen.queryByText(NAME_TAKEN_MESSAGE)).toBeNull());
    expect(createButton().disabled).toBe(false);
  });
});

describe('where the note goes', () => {
  it('creates in the selected folder, and says so under the title', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-folder'));

    expect(screen.getByTestId('new-note-target').textContent).toContain('Ideas');
    await user.click(createButton());

    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]).toEqual({ name: PREFILL, folderId: HARNESS_FOLDER_ID });
  });

  it('creates in the root when nothing is selected — `folderId: null`, not an omitted field', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-root'));

    expect(screen.getByTestId('new-note-target').textContent).toContain('home folder');
    await user.click(createButton());

    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]).toEqual({ name: PREFILL, folderId: null });
  });

  it('opens the same dialog from a context-menu row, which is the only thing that differs', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-menuitem'));
    await user.click(createButton());
    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]?.folderId).toBe(HARNESS_FOLDER_ID);
  });
});

describe('after create', () => {
  it('leaves the dialog, opens the note in the editor, focused, at the new URL', async () => {
    const { user, router, client } = await boot();
    await user.click(screen.getByTestId('open-new-note-root'));
    await user.click(createButton());

    await screen.findByTestId('editor-page');
    expect(screen.queryByTestId('new-note-dialog')).toBeNull();
    expect(router.state.location.pathname).toBe(`/app/note/${HARNESS_NEW_NOTE_ID}`);

    // The editor has the caret, and it is holding the note this dialog created: the row is in `['note', id]`
    // (so the page did not need a second request to render) and the focus handoff said this tab created it.
    expect(document.activeElement).toBe(screen.getByTestId('editor'));
    expect(screen.getByTestId('editor-page').dataset.wantsFocus).toBe('true');
    expect(screen.getByTestId('editor-note-name').textContent).toBe(PREFILL);

    // …and the sidebar's cache gained the row, metadata only: `['tree', userId]` is contractually content-free.
    const tree = client.getQueryData<TreeResponse>(queryKeys.tree(USER_ID));
    const added = tree?.notes.find((note) => note.id === HARNESS_NEW_NOTE_ID);
    expect(added).toMatchObject({ name: PREFILL, folderId: null });
    expect(added).not.toHaveProperty('content');
  });
});

describe('a server 409', () => {
  it('keeps the dialog open, says the server’s sentence, and preserves what was typed', async () => {
    const clash: Stub = () => ({
      status: 409,
      body: errorBody('CONFLICT', 'name already exists in this folder', { data: { id: HARNESS_NOTE_ID } }),
    });
    const { user, fake } = await boot({ routes: { 'POST /api/notes': clash } });

    await user.click(screen.getByTestId('open-new-note-root'));
    await user.clear(field());
    await user.type(field(), 'shared name');
    await user.click(createButton());

    const banner = await screen.findByTestId('new-note-server-error');
    expect(banner.textContent).toContain('name already exists in this folder');
    expect(screen.getByTestId('new-note-dialog')).toBeTruthy();
    // The text, not the focus: clicking `Create` leaves the caret on the button, as it would in a browser.
    // What §5 promises is that the box still holds what was typed, so it can be edited and retried.
    expect(field().value).toBe('shared name');
    expect(screen.getByTestId('new-note-dialog').contains(document.activeElement)).toBe(true);
    expect(screen.queryByTestId('editor-page')).toBeNull();
    expect(noteCreates(fake)).toHaveLength(1);
  });
});

describe('a dialog with nothing to check against', () => {
  it('opens, and still asks the API, when this tab has fetched no tree and has no session', async () => {
    // Not a UI curiosity: the tree cache is the only thing this dialog consults, and it must never be the
    // thing that decides whether a note can be created. The API decides that.
    const { user, fake, client } = await boot({ tree: null, user: null });

    await user.click(screen.getByTestId('open-new-note-root'));
    expect(field().value).toBe(PREFILL);
    await user.click(createButton());

    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]).toEqual({ name: PREFILL, folderId: null });
    // …and the create invented no sidebar for a user whose tree this tab never fetched.
    expect(client.getQueryData(queryKeys.tree(USER_ID))).toBeUndefined();
  });
});

describe('submitting', () => {
  it('takes Enter in the name field exactly as it takes the Create button', async () => {
    // The plan's keyboard rules (§11.5) send this dialog's users in through the buttons, and a text field
    // inside a `<form>` submits on Enter whatever this file says - so the guard in `submit()` has to be the
    // same guard the button enforces.
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-root'));
    await user.clear(field());
    await user.type(field(), 'typed');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(noteCreates(fake)).toHaveLength(1));
    expect(noteCreates(fake)[0]?.name).toBe('typed');
  });

  it('refuses Enter while the name is refused, rather than sending it and eating the 409', async () => {
    const { user, fake } = await boot();
    await user.click(screen.getByTestId('open-new-note-folder'));
    await user.clear(field());
    await user.type(field(), 'todo');
    await screen.findByText(NAME_TAKEN_MESSAGE);

    await user.keyboard('{Enter}');

    expect(screen.getByTestId('new-note-dialog')).toBeTruthy();
    expect(screen.queryByTestId('new-note-server-error')).toBeNull();
    expect(noteCreates(fake)).toHaveLength(0);
  });

  it('says its own sentence when the failure never reached the API, and keeps the dialog open', async () => {
    // The other half of the `409` case: a `fetch` that rejects is not "somebody took your name", and the
    // words on screen cannot pretend otherwise. Same behavior (stay open, keep the text), different story.
    const { user, fake } = await boot({
      routes: {
        'POST /api/notes': () => {
          throw new TypeError('failed to fetch');
        },
      },
    });
    await user.click(screen.getByTestId('open-new-note-root'));
    await user.click(createButton());

    expect((await screen.findByTestId('new-note-server-error')).textContent).toBe(UNKNOWN_CREATE_FAILURE);
    expect(screen.getByTestId('new-note-dialog')).toBeTruthy();
    expect(field().value).toBe(PREFILL);
    expect(noteCreates(fake)).toHaveLength(1);
  });
});

describe('Ctrl/Cmd+N', () => {
  it('is bound by nothing in this app, and does nothing to this dialog', async () => {
    const { user, fake } = await boot();

    // The chord must not open the dialog…
    await user.keyboard('{Meta>}n{/Meta}');
    await user.keyboard('{Control>}n{/Control}');
    expect(screen.queryByTestId('new-note-dialog')).toBeNull();

    // …nor close it, nor submit it, nor create anything. The focus is moved off the text field first, on
    // purpose: a key nobody claims still reaches the focused element, and jsdom (like a browser) types it
    // into an input. With a button focused, anything that changed the value would have an author, and this
    // test's claim is that there is none.
    await user.click(screen.getByTestId('open-new-note-root'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('new-note-cancel'));

    await user.keyboard('{Meta>}n{/Meta}');
    await user.keyboard('{Control>}n{/Control}');

    expect(screen.getByTestId('new-note-dialog')).toBeTruthy();
    expect(field().value).toBe(PREFILL);
    expect(document.activeElement).toBe(screen.getByTestId('new-note-cancel'));
    expect(noteCreates(fake)).toHaveLength(0);
  });

  it('appears in no source file as a key the app listens for', () => {
    // Chromium opens a new window/tab before any page handler sees this chord (docs/plans/mvp/MVP-15.md §5),
    // so binding it would ship a shortcut that works in Firefox and silently does nothing in Chrome. The
    // keyboard route to this dialog is its focusable buttons; the grep is the part a reviewer cannot skip.
    //
    // Test files are skipped: this file is the one place in `src` where the forbidden chord is written down.
    // `process.cwd()` is `apps/web` under `pnpm test`, and the assertion after it is what turns a wrong cwd
    // into a failing test rather than a scan of nothing that passes.
    const sources = sourceFilesUnder(join(process.cwd(), 'src')).filter(
      (file) => !/\.test\.tsx?$/.test(file),
    );
    expect(sources.some((file) => file.endsWith('NewNoteDialog.tsx'))).toBe(true);

    const reserved = [/key\b[^;\n]{0,24}['"]n['"]/i, /\b(?:mod|meta|cmd|ctrl|control)\+n\b/i];
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return reserved.some((pattern) => pattern.test(text));
    });
    expect(offenders).toEqual([]);
  });
});

/** Every `.ts`/`.tsx` source below `apps/web/src`, as absolute paths. */
function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.gen.ts')) found.push(path);
  }
  return found;
}
