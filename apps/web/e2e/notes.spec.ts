/**
 * Scenarios 2 and 7 — the naming rule a person sees, and the ciphertext nobody sees
 * (docs/plans/mvp/MVP-19.md §5.2, §5.7).
 *
 * **Why two of this file's tests are `test.fixme` and what that is claiming.** PR-19 is the MVP acceptance proof,
 * and two halves of it are not drivable in the tree this PR was built on:
 *
 * * `routes/app/note/$noteId.tsx` is PR-13's file. Without it nothing mounts a textarea, the toolbar transforms,
 *   the preview pane or `SaveStatus`, so "type a heading and a toolbar bold, the preview shows `<strong>`, the
 *   text survives a reload" has no element to happen to. `autosave.spec.ts` holds the same gap for scenarios 5
 *   and 6.
 * * `useNewNoteDialog()` (PR-15) is mounted nowhere: `TopBar.tsx`, `StatusBar.tsx` and `TreeContextMenu.tsx`
 *   never call it, which `MVP-15.md`'s own notes record as the consequence of PR-12 not existing when PR-15 was
 *   written. So there is no click that opens the new-note dialog, even though the dialog and its `data-testid`s
 *   are merged.
 *
 * `fixme` rather than deletion, because the brief forbids losing them (§7: a run where the DB leg does not
 * execute is a red build, and these are the other half of the same proof): the bodies say exactly which hook
 * each assertion is waiting for, and turning one red-to-green is deleting the word `fixme` after the PR that
 * lands the element. Nothing in here is a placeholder for a product claim — the two tests that *can* run assert
 * the naming rule through the tree and read the row through `e2e/db.ts`, and every `data-testid` they use exists
 * on `main` today.
 */
import { expect, test } from '@playwright/test';

import { createNote, readNote, writeNoteContent } from './api';
import { closeTestDb, readNoteAtRest } from './db';
import { NOTE_ENCRYPTION_KEY_VERSION } from './env';
import { ACCOUNT, createFolder, rowOf, signInNewAccount } from './fixtures';
import { closeResetPool, resetTestInstance } from './reset';

test.describe('the naming rule, in the tree', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeResetPool();
  });

  test('a note nobody named lands in the folder that was open, as new-file-<msepoch>.md', async ({
    page,
  }) => {
    await signInNewAccount(page, ACCOUNT.noteNaming);
    await page.goto('/app');

    const folder = await createFolder(page, 'Notebooks');

    // The seam PR-15's unmounted dialog forces (`api.ts` argues it). What is under test is not the request but
    // the name that comes back: `POST /api/notes` with no name generates `new-file-<msepoch>` (§9.2 #16), and
    // the tree is where the README's promise is kept — `new-file-<msepoch>.md`, the `.md` visible.
    const note = await createNote(page, { folderId: folder });
    await page.reload();

    const row = rowOf(page, 'note', note.id);
    await expect(row).toBeVisible();
    await expect(row).toContainText(/new-file-\d{13}\.md/u);
    // A name the person did not type is still a name the person can read: not truncated to the epoch, and not
    // doubled into `.md.md` by somebody re-adding the extension to a column that never held it.
    await expect(row).not.toContainText('.md.md');

    // …and the column really is extension-free (`withMd()` in `tree.selectors.ts` adds it for display only),
    // which is the half of the rule the tree alone cannot show.
    const stored = await readNote(page, note.id);
    expect(stored.status).toBe(200);
    expect(stored.body.name).toMatch(/^new-file-\d{13}$/u);
    // It landed where the person was standing, which is PR-15's `NewNoteTarget` rule and PR-09's `folderId`.
    expect(stored.body.folderId).toBe(folder);
  });

  test.fixme(
    'the new-note dialog prefills the generated name and its .md cannot be edited ' +
      '[blocked: nothing mounts useNewNoteDialog() — TopBar/StatusBar/TreeContextMenu still do not call it]',
    async ({ page }) => {
      await signInNewAccount(page, ACCOUNT.noteNaming);
      await page.goto('/app');

      // Waiting for: the "New note" button PR-15's `useNewNoteDialog().openFor()` is meant to be wired to, and
      // which PR-19 §2 lists as `new-note`.
      await page.getByTestId('new-note').click();

      const field = page.getByTestId('new-note-name');
      await expect(field).toBeVisible();
      await expect(field).toHaveValue(/^new-file-\d{13}$/u);
      // The suffix is a sibling of the input, not a character in it — that is what makes "cannot be deleted"
      // a property of the markup rather than of a keydown handler.
      const suffix = page.getByTestId('new-note-suffix');
      await expect(suffix).toHaveText('.md');
      await expect(field).not.toHaveValue(/\.md/u);

      await page.getByTestId('new-note-create').click();
      await expect(page.getByTestId('new-note-dialog')).toHaveCount(0);
    },
  );

  test.fixme(
    'a heading and a toolbar bold render <strong>, and the text is still there after a reload ' +
      '[blocked: PR-13 has not landed routes/app/note/$noteId.tsx, so no page mounts `editor`/`editor-toolbar`/`preview`]',
    async ({ page }) => {
      await signInNewAccount(page, ACCOUNT.noteNaming);
      await page.goto('/app');

      // Waiting for the editor pane. The hooks are already named in PR-19 §2 (`editor`, `editor-toolbar`,
      // `preview`, `mode-split|write|preview`), and `save-status` is merged (PR-14) — only the page that hosts
      // them is missing.
      const note = await createNote(page, { name: 'heading', content: 'plain words\n' });
      await page.goto(`/app/note/${note.id}`);

      const editor = page.getByTestId('editor');
      await editor.fill('# A heading\nand **bold** words\n');

      // The toolbar transform, not a typed asterisk: bold is applied to the selection by the button.
      await editor.click();
      await page.getByTestId('editor-toolbar').getByTestId('toolbar-bold').click();
      await expect(editor).toContainText('**bold**');

      await page.getByTestId('mode-preview').click();
      await expect(page.getByTestId('preview').locator('strong')).toHaveCount(2);

      await page.reload();
      await expect(page.getByTestId('editor')).toContainText('A heading');
      await expect(page.getByTestId('editor')).toContainText('**bold**');
    },
  );
});

test.describe('the row itself, at rest', () => {
  test.beforeAll(async () => {
    await resetTestInstance();
  });

  test.afterAll(async () => {
    await closeTestDb();
    await closeResetPool();
  });

  test('a saved body is ciphertext in notes: the marker is nowhere in the raw bytes, the IV is 12 bytes, key_version is the current one, re-saving an unchanged body changes the ciphertext, and name stays plaintext', async ({
    page,
  }) => {
    await signInNewAccount(page, ACCOUNT.atRest);
    await page.goto('/app');

    const folder = await createFolder(page, 'Locked');
    // A marker this run invented, so the assertion cannot pass by finding last run's text in a leftover row.
    const marker = `quantum-fox-${Date.now().toString(36)}`;
    const body = `# Field notes

The marker is ${marker}, and it must not appear in the row that holds it.

Two more words for the word count.
`;

    const note = await createNote(page, { name: 'field-notes', folderId: folder, content: body });
    await page.reload();
    await expect(rowOf(page, 'note', note.id)).toContainText('field-notes.md');

    // ── the four things plan §17's "DB rows are ciphertext" claim needs, read out of the row (§5.7). ──
    const row = await readNoteAtRest(note.id);
    if (row === null) throw new Error(`notes has no row for the note the app just created (${note.id})`);

    // (1) The marker, and the body, are absent from `content_cipher` — compared **as bytes**, because `bytea`
    //     decoded to a string and then searched would let an encoding accident decide the answer.
    const cipher = Buffer.from(row.cipher);
    expect(cipher.includes(Buffer.from(marker, 'utf8'))).toBe(false);
    expect(cipher.includes(Buffer.from(body, 'utf8'))).toBe(false);
    //     Non-empty, and bigger than the body it carries: AES-256-GCM appends a 16-byte tag, so an empty blob
    //     (the "it stored nothing" failure) and a truncated one are both distinguishable here.
    expect(cipher.byteLength).toBeGreaterThan(Buffer.byteLength(body, 'utf8'));

    // (2) `content_iv` is exactly 12 bytes (the GCM nonce `crypto/envelope.ts` pins).
    expect(Buffer.from(row.iv).byteLength).toBe(12);

    // (3) `key_version` is the keyring version the server was booted with — read from the harness's own
    //     environment rather than hardcoded to 1, so the assertion is still an assertion when it is changed.
    expect(row.keyVersion).toBe(Number(NOTE_ENCRYPTION_KEY_VERSION));

    // (4) The accepted opposite, asserted so a reader sees both halves of the guarantee: `notes.name` is
    //     plaintext on purpose (docs/DATA-MODEL.md §2, the documented search limitation), so the note is still
    //     findable by name while its body is unreadable.
    expect(row.name).toBe('field-notes');
    expect(Buffer.from(row.name, 'utf8').includes(marker)).toBe(false);

    // ── (5) The assertion that stops this scenario from passing on a stored copy of the plaintext: write the
    //     *unchanged* body back and the ciphertext has to be different bytes, because the IV is fresh per write.
    const beforeCipher = Buffer.from(row.cipher);
    const beforeIv = Buffer.from(row.iv);
    const again = await writeNoteContent(page, { id: note.id, content: body, baseVersion: row.version });
    expect(again.status).toBe(200);

    const after = await readNoteAtRest(note.id);
    if (after === null) throw new Error('the row disappeared between the first read and the re-save');
    expect(Buffer.from(after.cipher).equals(beforeCipher)).toBe(false);
    expect(Buffer.from(after.iv).equals(beforeIv)).toBe(false);
    //     Same row, not a new one: a content write bumps `version` (a rotation never does, PR-06), and the
    //     plaintext it decrypts to is the one that went in.
    expect(after.version).toBe(row.version + 1);
    expect(after.name).toBe('field-notes');
    const decrypted = await readNote(page, note.id);
    expect(decrypted.status).toBe(200);
    expect(decrypted.body.content).toBe(body);

    // ── (6) Scenario 2's "reload the page and the text is still there", asserted at the layer the merged product
    //     has: the summary's size facts are computed from the plaintext when the body is sealed
    //     (`contentStats()` in `crypto/envelope.ts`), so the byte count and the word count on screen after a
    //     reload are statements about the body surviving, not about a name surviving. `autosave.spec.ts` and the
    //     `fixme` editor test above own the version of this claim that needs a textarea.
    await page.reload();
    await rowOf(page, 'note', note.id).dblclick();
    const facts = page.getByTestId('app-note-facts');
    await expect(facts).toContainText(`${Buffer.byteLength(body, 'utf8')} bytes`);
    await expect(facts).toContainText(String(body.split(/\s+/u).filter((word) => word !== '').length));
  });
});
