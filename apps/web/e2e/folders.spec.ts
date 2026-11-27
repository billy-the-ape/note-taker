/**
 * Scenarios 3 and 4 — rename, move, and the delete that makes you type (docs/plans/mvp/MVP-19.md §5.3, §5.4).
 *
 * Both are driven through PR-12's tree: a row's `row-menu-<id>` button, then the rename / move / delete dialog
 * each row asks for. The one thing the browser cannot do for these scenarios is *make a note*: `TopBar`,
 * `StatusBar` and the tree context menu do not mount PR-15's new-note dialog (its own brief, `MVP-15.md`,
 * records that those three files did not exist when it shipped), so `createNote` in `api.ts` puts a row in the
 * tree and every assertion after that is made against the rendered tree.
 *
 * Two facts about the app's naming rules are asserted rather than assumed, because both are the kind of thing a
 * test quietly gets wrong: a stored note name never contains `.md` (plan §8 — `notes.name` is extension-free),
 * and the tree shows it *with* `.md` (`displayName()`/`withMd()`), so "the tree shows the new name with `.md`"
 * is a statement about the row, not about the column.
 */
import { expect, test } from '@playwright/test';

import { createNote } from './api';
import {
  ACCOUNT,
  createFolder,
  deleteConfirmName,
  moveThroughUi,
  renameThroughUi,
  rowOf,
  runRowAction,
  signInNewAccount,
} from './fixtures';
import { closeResetPool, resetTestInstance } from './reset';

test.describe('renaming and moving a note', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  test('a rename puts the new name in the tree with .md, and a move changes where the note says it lives', async ({
    page,
  }) => {
    await signInNewAccount(page, ACCOUNT.renameMove);
    await page.goto('/app');

    const reports = await createFolder(page, 'Reports');
    const archive = await createFolder(page, 'Archive');

    // The seam: a note inside `Reports`. It has no name clash with anything, and the tree must be re-read to see
    // a row it did not create, which is the same refresh a person gets by reloading.
    const note = await createNote(page, { name: 'quarterly', folderId: reports });
    await page.reload();
    const row = rowOf(page, 'note', note.id);
    await expect(row).toBeVisible();
    await expect(row).toContainText('quarterly.md');

    // ── §5.3's first half: rename through the dialog, and read the row back.
    await runRowAction(page, note.id, 'menu-rename');
    await renameThroughUi(page, 'budget');
    await expect(row).toContainText('budget.md');
    // The extension stayed out of the column: had the dialog written `budget.md`, the tree would read
    // `budget.md.md`, and `displayName()` is idempotent enough that a weaker assertion would still pass.
    await expect(row).not.toContainText('budget.md.md');
    await expect(row).not.toContainText('quarterly');

    // ── §5.3's second half: move it, then ask the app where the note is.
    await runRowAction(page, note.id, 'menu-move');
    await moveThroughUi(page, `move-target-${archive}`);

    // The tree path, in the app's own words: opening the note renders its location breadcrumb, and after the move
    // that sentence has to say `Archive`, not `Reports`.
    await row.dblclick();
    await expect(page.getByTestId('app-note-summary')).toBeVisible();
    await expect(page.getByTestId('app-note-location')).toHaveText('Archive');

    // And the dialog agrees: reopen it and the radio that is marked current is the new folder. A move that only
    // moved the summary would fail here rather than in someone's sidebar a week later.
    await page.getByTestId('app-note-close').click();
    await runRowAction(page, note.id, 'menu-move');
    await expect(page.getByTestId(`move-target-${archive}`)).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId(`move-target-${reports}`)).not.toHaveAttribute('data-current', 'true');
    await page.getByTestId('move-cancel').click();
  });
});

test.describe('a delete that has to be typed', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  test('a folder with something in it cannot be deleted until its name is typed, and then it takes the note too', async ({
    page,
  }) => {
    await signInNewAccount(page, ACCOUNT.typedDelete);
    await page.goto('/app');

    const landing = await createFolder(page, 'Landing');
    const note = await createNote(page, { name: 'first-draft', folderId: landing });
    await page.reload();
    await expect(rowOf(page, 'note', note.id)).toBeVisible();

    await runRowAction(page, landing, 'menu-delete');
    const dialog = page.getByTestId('delete-confirm');
    await expect(dialog).toBeVisible();
    // §5's gate is the button, not a warning next to it: the dialog counts the subtree, sees the note, and asks
    // for the name. `subtreeCounts` puts that count in the same sentence.
    const typed = page.getByTestId('delete-confirm-name-input');
    const submit = page.getByTestId('delete-confirm-submit');
    await expect(typed).toBeVisible();
    await expect(dialog).toContainText('1 note goes with it');
    await expect(submit).toBeDisabled();

    // "Deleting without typing the name is blocked", asserted as the app implements it: a name that is not the
    // name does not unlock it, and the rows are still on screen while the dialog is open and after it is closed.
    await typed.fill('Lan');
    await expect(submit).toBeDisabled();
    await typed.fill('landing');
    await expect(submit).toBeDisabled();

    const name = await deleteConfirmName(page);
    await page.getByTestId('delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(page, 'folder', landing)).toBeVisible();
    await expect(rowOf(page, 'note', note.id)).toBeVisible();

    // Typed exactly: the cascade goes over the subtree, so both rows leave the tree.
    await runRowAction(page, landing, 'menu-delete');
    await typed.fill(name);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(page, 'folder', landing)).toHaveCount(0);
    await expect(rowOf(page, 'note', note.id)).toHaveCount(0);
  });

  test('a folder with nothing in it says so, and needs no typing', async ({ page }) => {
    await signInNewAccount(page, ACCOUNT.emptyFolderDelete);
    await page.goto('/app');

    const scratch = await createFolder(page, 'Scratch');
    await runRowAction(page, scratch, 'menu-delete');
    await expect(page.getByTestId('delete-confirm-empty-hint')).toBeVisible();
    await expect(page.getByTestId('delete-confirm-submit')).toBeEnabled();
    await page.getByTestId('delete-confirm-submit').click();
    await expect(rowOf(page, 'folder', scratch)).toHaveCount(0);
  });
});
