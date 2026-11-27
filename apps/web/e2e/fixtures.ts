/**
 * The small vocabulary the specs share (docs/plans/mvp/MVP-19.md §5).
 *
 * Two rules, both learned from the way this repo's component tests are written:
 *
 * * **`data-testid` only, never structure.** Every locator here goes through a `data-testid` PR-08…PR-16 left
 *   behind, because a test that walks `li > div:nth-child(2)` fails on a padding change and passes for the wrong
 *   reason. Where the tree needs an id (a row's menu is `row-menu-<id>`), the id is read out of the row's own
 *   `data-node-id` rather than guessed from a response body the UI never saw.
 * * **A helper does one user gesture.** `createFolder` clicks the buttons a person clicks and then waits for the
 *   tree to say so; it does not reach for the API. The seams in `api.ts` are the exception and they argue
 *   themselves in that file's header.
 */

import type { TreeResponse } from '@note-taker/contracts';
import { expect, type Locator, type Page } from '@playwright/test';

import { fetchTree, setupInstance, signUp } from './api';

/** One account per scenario: one user is one tree, and a shared tree makes "empty" unassertable. */
export const ACCOUNT = {
  owner: 'e2e.scenario1.owner',
  noteNaming: 'e2e.scenario2.owner',
  renameMove: 'e2e.scenario3.owner',
  typedDelete: 'e2e.scenario4.owner',
  emptyFolderDelete: 'e2e.scenario4b.owner',
  autosave: 'e2e.scenario5.owner',
  conflict: 'e2e.scenario6.owner',
  // Not a scenario of its own: the cookie/CSRF test in `auth.spec.ts` needs an account it can sign in as in both
  // modes that file runs in (whole suite, or `-g` on its own), and neither `e2eowner` (which `setupInstance`
  // bootstraps) nor `e2e.scenario1.owner` (which the first test's form creates) is present in both.
  csrfPair: 'e2e.scenario1.csrf',
  atRest: 'e2e.scenario7.owner',
} as const;

/**
 * Signs the page into an instance and creates `username`, in that order.
 *
 * `setupInstance` runs first because `POST /api/auth/register` refuses to create a member on an instance with no
 * owner (`auth.service.ts`): the door that opens without an owner is `/setup`, and only once. Afterwards the
 * browser holds that member's session cookie, so the caller's `page.goto('/app')` lands inside the app.
 */
export async function signInNewAccount(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await setupInstance(page);
  await signUp(page, username);
}
/** The tree row for one node, by kind and id. */
export function rowOf(page: Page, kind: 'folder' | 'note', id: string): Locator {
  return page.getByTestId(`${kind}-row-${id}`);
}

/**
 * A folder's id, looked up by name, and then *seen* in the tree.
 *
 * The id comes from the tree response rather than from the DOM, because a tree row's accessible text is the
 * label plus its own "Actions for …" button (`TreeRow` renders the menu inside the row), so matching a name to a
 * row by text is a comparison against a string the test does not own. The row is still the assertion: this
 * returns only once `folder-row-<id>` is on screen, which is the half that says the click created something.
 */
export async function folderIdByName(page: Page, name: string): Promise<string> {
  const id = await waitForTreeRow(page, 'folder', name);
  await expect(rowOf(page, 'folder', id)).toBeVisible();
  return id;
}

/** Polls the tree the app is rendering for a node with this exact name, and answers with its id. */
async function waitForTreeRow(page: Page, kind: 'folder' | 'note', name: string): Promise<string> {
  let last: TreeResponse | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await fetchTree(page);
    const nodes = kind === 'folder' ? last.folders : last.notes;
    const found = nodes.find((node) => node.name === name);
    if (found !== undefined) return found.id;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `no ${kind} named ${JSON.stringify(name)} in the tree — it holds ${JSON.stringify(
      last === undefined ? [] : [...last.folders, ...last.notes].map((node) => node.name),
    )}`,
  );
}

/**
 * Creates a folder the only way it can be created today: the tree's inline new-folder form (PR-12).
 *
 * Returns the id, because the scenarios that need a folder need to point a row or a request at it afterwards.
 */
export async function createFolder(page: Page, name: string): Promise<string> {
  await page.getByTestId('new-folder').click();
  const form = page.getByTestId('new-folder-form');
  await expect(form).toBeVisible();
  await page.getByTestId('new-folder-name').fill(name);
  await page.getByTestId('new-folder-submit').click();
  await expect(form).toHaveCount(0);

  const id = await folderIdByName(page, name);
  await expect(rowOf(page, 'folder', id)).toBeVisible();
  return id;
}

/** Opens a row's context menu (the row's own `row-menu-<id>` button) and clicks one of its items. */
export async function runRowAction(
  page: Page,
  id: string,
  item: 'menu-rename' | 'menu-move' | 'menu-delete' | 'menu-new-folder',
): Promise<void> {
  await page.getByTestId(`row-menu-${id}`).click();
  await page.getByTestId(item).click();
}

/** Fills the rename dialog and submits it. */
export async function renameThroughUi(page: Page, to: string): Promise<void> {
  const dialog = page.getByTestId('rename-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('rename-name').fill(to);
  await page.getByTestId('rename-submit').click();
  await expect(dialog).toHaveCount(0);
}

/** Picks a destination in the move dialog (`move-target-<id>`, or `move-target-root`) and submits. */
export async function moveThroughUi(page: Page, targetTestId: string): Promise<void> {
  const dialog = page.getByTestId('move-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId(targetTestId).check();
  await page.getByTestId('move-submit').click();
  await expect(dialog).toHaveCount(0);
}

/** The name the delete dialog is asking to be typed, read off its own label rather than hardcoded. */
export async function deleteConfirmName(page: Page): Promise<string> {
  const label = page.getByText(/^Type “.+” to confirm$/u);
  await expect(label).toBeVisible();
  const text = (await label.textContent()) ?? '';
  const found = /^Type “(.+)” to confirm$/u.exec(text);
  if (found === null || found[1] === undefined) {
    throw new Error(`could not read the typed-name label out of ${JSON.stringify(text)}`);
  }
  return found[1];
}
