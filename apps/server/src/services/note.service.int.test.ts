/**
 * `services/note.service.ts` over a real Postgres (docs/plans/mvp/MVP-09.md §5.5–§5.6, §7).
 *
 * The interesting assertions here are the two that involve bytes:
 *
 * * **A note is never empty in storage** (§5.6). `POST` with no content seals `''`, so the row carries a real
 *   12-byte IV and a 16-byte tag rather than two `NULL`s that a later `GET` would have to guess about. The
 *   `content_bytes = 0` next to a non-empty `content_cipher` is the whole idea in one row.
 * * **A body that does not authenticate is an error, not an empty note.** Tampering with the stored ciphertext
 *   makes `openNoteContent()` throw `EnvelopeError`; the service lets it through and
 *   `routes/notes.routes.int.test.ts` asserts the 500. What this file asserts is the half that is a service
 *   property: the failure surfaces as that class, and no code path turns it into `content: ''`.
 *
 * The name rules are asserted against exact strings, because `new-file-<msepoch>` and `plan-2` are the contract's
 * text (`packages/contracts/src/names.ts`), not this file's invention.
 */
import { NOTE_CONTENT_MAX_BYTES, type NoteWithContent } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { EnvelopeError } from '../crypto/envelope.js';
import { getKeyring } from '../crypto/keys.js';
import { listAllNotes, noteById } from '../db/repositories/notes.repo.js';
import { ConflictError, NotFoundError, PayloadTooLargeError } from '../domain/errors.js';
import { createUser } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { createFolderService } from './folder.service.js';
import { createNoteService } from './note.service.js';

const db = testDb();
const keyring = getKeyring();
/** The clock is pinned, so the generated name is asserted character for character. */
const NOW_MS = 1_700_000_000_000;
const notes = createNoteService({ db, keyring, now: () => NOW_MS });
const folders = createFolderService({ db });

beforeEach(async () => {
  await resetDb();
});

/** The stored row, read with a statement no repository owns: this test cares about the columns, not the API shape. */
async function noteRow(id: string): Promise<Record<string, unknown>> {
  const rows = await catalogRows(
    sql`select name, folder_id, version, content_bytes, word_count,
               octet_length(content_cipher) as cipher_bytes, octet_length(content_iv) as iv_bytes,
               content_format, key_version
          from notes where id = ${id}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`no note row for ${id}`);
  return row;
}

describe('POST /api/notes naming (§5.5)', () => {
  it('generates new-file-<msepoch>, extension-free, when the body names nothing', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });

    const first = await notes.create({ userId: user.id });
    expect(first.name).toBe(`new-file-${NOW_MS}`);
    expect(first.name).not.toContain('.md');

    // The same instant twice in the same folder is a double-clicked button, not an error: the *generated* name is
    // the only one the server may change on its own (§5.5).
    const second = await notes.create({ userId: user.id });
    expect(second.name).toBe(`new-file-${NOW_MS}-2`);
    expect(second.id).not.toBe(first.id);
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(2);
  });

  it('strips the display extension and stores the base', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'Draft.md', content: 'hello' });
    expect(created.name).toBe('Draft');
    expect((await noteRow(created.id)).name).toBe('Draft');

    // A rename keeps the rule: `notes.name` never carries `.md`, whichever way it was written.
    const renamed = await notes.patch({ userId: user.id, id: created.id, name: 'Final.md' });
    expect(renamed.name).toBe('Final');
    expect((await noteRow(created.id)).name).toBe('Final');
  });

  it("answers a sibling clash with the winner's id, without renaming either note", async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const folder = await folders.create({ userId: user.id, name: 'docs' });
    const taken = await notes.create({ userId: user.id, name: 'plan', folderId: folder.id });

    const attempt = notes.create({ userId: user.id, name: 'plan.md', folderId: folder.id });
    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as ConflictError,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.data).toEqual({ id: taken.id });
    expect(error?.details?.[0]?.path).toBe('name');
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(1);

    // A rename into an occupied name is refused the same way, and the note keeps its own name.
    const other = await notes.create({ userId: user.id, name: 'other', folderId: folder.id });
    const renamed = await notes.patch({ userId: user.id, id: other.id, name: 'plan' }).then(
      () => undefined,
      (thrown: unknown) => thrown as ConflictError,
    );
    expect(renamed).toBeInstanceOf(ConflictError);
    expect((await noteById(db, { userId: user.id, id: other.id }))?.name).toBe('other');
  });
});

describe('the envelope (§5.6, §7)', () => {
  it('seals the empty string when content is omitted, and reads it back as the empty string', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'blank' });

    expect(created.content).toBe('');
    expect(created.contentBytes).toBe(0);
    expect(created.wordCount).toBe(0);

    const row = await noteRow(created.id);
    // §5.6: a real envelope, never empty columns — 12-byte IV, and a ciphertext that is the tag at minimum.
    expect(row.iv_bytes).toBe(12);
    expect(Number(row.cipher_bytes)).toBeGreaterThanOrEqual(16);
    expect(row.content_bytes).toBe(0);
    expect(row.content_format).toBe('markdown');
    expect(row.key_version).toBe(keyring.current.version);

    // The read path is the one that has to decrypt, and it is what `GET` is built on.
    const read = await notes.read({ userId: user.id, id: created.id });
    expect(read.content).toBe('');
  });

  it('round-trips a body with non-ASCII text through the keyring', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const text = '# Über\n\nconst 🖥️ = "café";\n\n佐藤さん\n';
    const created = await notes.create({ userId: user.id, name: 'unicode', content: text });

    const expectedBytes = new TextEncoder().encode(text).byteLength;
    expect(created.contentBytes).toBe(expectedBytes);
    expect(expectedBytes).toBeGreaterThan([...text].length);
    const read = await notes.read({ userId: user.id, id: created.id });
    expect(read.content).toBe(text);
    expect((await noteRow(created.id)).content_bytes).toBe(expectedBytes);
  });

  it('refuses a body over the cap before it seals or stores anything', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const tooBig = 'x'.repeat(NOTE_CONTENT_MAX_BYTES + 1);

    const error = await notes.create({ userId: user.id, name: 'huge', content: tooBig }).then(
      () => undefined,
      (thrown: unknown) => thrown as PayloadTooLargeError,
    );
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(0);
  });

  it('surfaces an authenticated-encryption failure as EnvelopeError, never as an empty body', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'tampered', content: 'the only copy' });

    // Replace the ciphertext with 32 bytes of something else: same shape, wrong tag. This is the state a bit-flip,
    // a partial write, or a restored dump from another key would leave, and the API must not dress it up as an
    // empty note (§7's crypto criterion).
    await catalogRows(sql`update notes set content_cipher = sha256(content_cipher) where id = ${created.id}`);

    const error = await notes.read({ userId: user.id, id: created.id }).then(
      (value: NoteWithContent) => value,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(EnvelopeError);
    // The id is on the error so the log line can name the row; the client-facing half stays generic.
    expect((error as EnvelopeError).noteId).toBe(created.id);
    expect((error as EnvelopeError).message).not.toContain('the only copy');
  });
});

describe('root, move, and version (§4 #19, §7)', () => {
  it('creates at the root, moves into a folder, and moves back to the root', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const folder = await folders.create({ userId: user.id, name: 'somewhere' });

    const atRoot = await notes.create({ userId: user.id, name: 'float' });
    expect(atRoot.folderId).toBeNull();

    const moved = await notes.patch({ userId: user.id, id: atRoot.id, folderId: folder.id });
    expect(moved.folderId).toBe(folder.id);

    const back = await notes.patch({ userId: user.id, id: atRoot.id, folderId: null });
    expect(back.folderId).toBeNull();
    expect((await noteRow(atRoot.id)).folder_id).toBeNull();
  });

  it('leaves version untouched across a rename and a move', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const folder = await folders.create({ userId: user.id, name: 'target' });
    const created = await notes.create({ userId: user.id, name: 'steady', content: 'one two three' });
    expect([created.version, created.wordCount]).toEqual([1, 3]);

    const renamed = await notes.patch({ userId: user.id, id: created.id, name: 'renamed' });
    expect(renamed.version).toBe(1);
    const moved = await notes.patch({ userId: user.id, id: created.id, folderId: folder.id });
    expect(moved.version).toBe(1);
    // Statistics belong to the content, so a move re-derives nothing: same words, same bytes.
    expect([moved.wordCount, moved.contentBytes]).toEqual([3, created.contentBytes]);
    expect((await noteRow(created.id)).version).toBe(1);
  });

  it('deletes the row and its ciphertext together, and a second delete is a 404', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'temporary', content: 'body' });
    await notes.remove({ userId: user.id, id: created.id });
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(0);

    const again = await notes.remove({ userId: user.id, id: created.id }).then(
      () => undefined,
      (thrown: unknown) => thrown as NotFoundError,
    );
    expect(again).toBeInstanceOf(NotFoundError);
  });
});

describe('ownership on body ids (§5.4)', () => {
  it("refuses another user's folder on create and on move", async () => {
    const a = await createUser(db, { username: 'a', role: 'member' });
    const b = await createUser(db, { username: 'b', role: 'member' });
    const theirs = await folders.create({ userId: b.id, name: 'theirs' });
    const mine = await notes.create({ userId: a.id, name: 'mine' });

    await expect(
      notes.create({ userId: a.id, name: 'intruder', folderId: theirs.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(notes.patch({ userId: a.id, id: mine.id, folderId: theirs.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(await listAllNotes(db, { userId: a.id })).toHaveLength(1);
    const after = await noteById(db, { userId: a.id, id: mine.id });
    expect(after?.folderId).toBeNull();
    // Nothing of theirs was touched either.
    expect(await listAllNotes(db, { userId: b.id })).toHaveLength(0);
  });

  it('reads, patches and deletes only my own rows', async () => {
    const a = await createUser(db, { username: 'a', role: 'member' });
    const b = await createUser(db, { username: 'b', role: 'member' });
    const theirs = await notes.create({ userId: b.id, name: 'private', content: 'not yours' });

    for (const attempt of [
      notes.read({ userId: a.id, id: theirs.id }),
      notes.patch({ userId: a.id, id: theirs.id, name: 'mine' }),
      notes.remove({ userId: a.id, id: theirs.id }),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await notes.read({ userId: b.id, id: theirs.id })).content).toBe('not yours');
  });
});
