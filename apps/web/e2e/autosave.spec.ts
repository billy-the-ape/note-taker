/**
 * Scenarios 5 and 6 — the save-status pill, and two pages that disagree
 * (docs/plans/mvp/MVP-19.md §5.5, §5.6). **Both ran `test.fixme` until PR-13 landed the editor route;**
 * they are live now, and a failure in either is a fact about PR-13, PR-14 or PR-16 — see §2's rule at the top of
 * `notes.spec.ts` about the one assertion that is allowed to change.
 *
 * PR-14 is merged and its half is genuinely here: `useAutosave()`, the `Autosaver` debounce in `lib/autosave.ts`,
 * `SaveStatus` (whose own comment names this file — `SAVE_STATUS_TEST_ID` is "the `data-testid` PR-19 asserts
 * on"), `ConflictBanner`, and PR-16's `settings-autosave-toggle` wired to `PATCH /api/settings`. What is missing
 * is the page that puts them on screen. `routes/app/note/$noteId.tsx` is PR-13's file: it owns the textarea
 * (`editor`), the toolbar, the preview, and the mount that reads `useAutosaveEnabled()` and hands a snapshot to
 * `SaveStatus`. Without it there is no buffer to pause over, no `Ctrl+S` to press and no stale page to disagree
 * with, so these two scenarios have nothing to assert *about* — and the honest form for that is a skipped test
 * that says what it is waiting for, not a green one that asserts nothing.
 *
 * Reading them: the body of each is the scenario as the brief specifies it, against hooks that exist on `main`
 * today (`save-status`, `conflict-banner`, `settings-autosave-toggle`) and the three that PR-13's §4 names
 * (`editor`, `mode-preview`, and the `app/note/$noteId` route itself). Landing PR-13 turns each into a real
 * result by deleting the word `fixme`; if a hook then disagrees with what is written here, that is a PR-13
 * review finding, which is the cheaper place to find it out.
 *
 * The `1 500` millisecond pause in scenario 5 is deliberately past the 1200 ms debounce (§5.5 says "deliberately
 * past"), and the two-page conflict test is the one place in the suite where two pages on one note is the point —
 * `workers: 1` in `playwright.config.ts` serializes *files*, not the concurrency inside a test.
 */
import { expect, test } from '@playwright/test';

import { createNote, readNote, writeNoteContent } from './api';
import { ACCOUNT, signInNewAccount } from './fixtures';
import { closeResetPool, resetTestInstance } from './reset';

test.describe('the save-status pill', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  // PR-13 landed the route: `routes/app/note/$noteId.tsx` mounts `editor` (PR-14's buffer in a control) and
  // `save-status` (PR-14's pill), which is everything this test needed from outside PR-14 to exist.
  test('pausing past the debounce writes the note and the pill says Saved; with autosave off it says Unsaved changes until Ctrl+S', async ({
    page,
  }) => {
    await signInNewAccount(page, ACCOUNT.autosave);
    const note = await createNote(page, { name: 'autosave', content: 'first line\n' });
    await page.goto(`/app/note/${note.id}`);

    const editor = page.getByTestId('editor');
    const pill = page.getByTestId('save-status');
    await expect(editor).toHaveValue('first line\n');
    await editor.fill('first line\nsecond line, typed and left alone\n');

    // §5.5: pause 1.5 s, which is past the 1200 ms debounce rather than near it, so a debounce that never
    // fires and a debounce of 2 s look different here.
    await expect(pill).toHaveText(/Unsaved changes/u);
    await page.waitForTimeout(1_500);
    await expect(pill).toContainText('Saved');

    // Settings owns the flag (PR-16), and the editor re-reads it through `useAutosaveEnabled()`, so the pill
    // has to change its mind without a reload.
    await page.goto('/app/settings');
    await expect(page.getByTestId('settings-autosave-toggle')).toBeChecked();
    await page.getByTestId('settings-autosave-toggle').click();
    await expect(page.getByTestId('settings-autosave-toggle')).not.toBeChecked();

    await page.goto(`/app/note/${note.id}`);
    await editor.fill('first line\nsecond line, typed and left alone\nthird line with autosave off\n');
    // The other copy, not a nag: `AUTOSAVE_OFF_COPY` in `SaveStatus.tsx` is this sentence for this state.
    await expect(pill).toHaveText('Autosave off — Ctrl+S to save');
    await page.waitForTimeout(1_500);
    await expect(pill).toHaveText('Autosave off — Ctrl+S to save');

    await page.keyboard.press('Control+s');
    await expect(pill).toContainText('Saved');

    // The pill is not the write. Reading the note back through the API says the buffer really reached the row,
    // which is the difference between a status component and a save.
    const written = await readNote(page, note.id);
    expect(written.status).toBe(200);
    expect(written.body.content).toContain('third line with autosave off');
  });
});

test.describe('two pages, one note', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  // PR-13 landed the page that holds a buffer: two tabs on the same note now means two machines, which is
  // the only way this conflict can be produced in a browser.
  test('the stale page is shown the conflict and nothing is silently overwritten', async ({
    page,
    context,
  }) => {
    await signInNewAccount(page, ACCOUNT.conflict);
    const note = await createNote(page, { name: 'conflict', content: 'shared starting text\n' });

    const fresh = await context.newPage();
    await fresh.goto(`/app/note/${note.id}`);
    await page.goto(`/app/note/${note.id}`);

    // Both pages loaded at version N. This one writes first, through the API so the ordering is a fact of the
    // test rather than of two autosave timers racing.
    const firstWrite = await writeNoteContent(page, {
      id: note.id,
      content: 'written by page A\n',
      baseVersion: note.version,
    });
    expect(firstWrite.status).toBe(200);

    // The stale page now writes against the version it read. PR-10 answers 409 `VERSION_CONFLICT` with the
    // server's current content and version, which is PR-14's comparison input.
    await fresh.getByTestId('editor').fill('written by page B\n');
    await fresh.keyboard.press('Control+s');

    // §5.6: the conflict UI, in the stale page, carrying what the server actually holds — and the row still
    // holds A's text, so "no silent overwrite" is a claim about the database and not only about the screen.
    const banner = fresh.getByTestId('conflict-banner');
    await expect(banner).toBeVisible();
    await expect(fresh.getByTestId('conflict-server-version')).toHaveText(String(firstWrite.body.version));
    await expect(fresh.getByTestId('conflict-server-text')).toContainText('written by page A');

    // …and the row still says what the winning page wrote, at the winning version. B's text is nowhere in it:
    // "no silent overwrite" is a claim about the database, so it is checked there rather than inferred from a
    // banner being present.
    const after = await readNote(page, note.id);
    expect(after.status).toBe(200);
    expect(after.body.version).toBe(firstWrite.body.version);
    expect(after.body.content).toBe('written by page A\n');
    expect(after.body.content).not.toContain('written by page B');
  });
});
