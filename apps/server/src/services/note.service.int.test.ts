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
 *
 * PR-10 added the write side at the bottom of this file, where the two decisions that belong to the service rather
 * than to the transport are measurable: what a failed conditional update *means* (`404` versus a
 * `VERSION_CONFLICT` carrying the server's body), and what it means when the row it would have described cannot
 * be decrypted.
 */
import { MAX_NOTE_VERSION, NOTE_CONTENT_MAX_BYTES, type NoteWithContent } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { EnvelopeError } from '../crypto/envelope.js';
import { getKeyring } from '../crypto/keys.js';
import { listAllNotes, noteById } from '../db/repositories/notes.repo.js';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  VersionConflictError,
} from '../domain/errors.js';
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

  it('creates four nameless notes at one instant without any of them losing', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });

    // The test above is sequential, and sequential is the easy case for free: by the time the second create reads
    // the folder's names, the first has committed. Started together is the case the code has to earn — every one
    // of these reads "no names yet", so every one picks `new-file-<NOW_MS>`, and `notes_unique_sib` then admits
    // exactly one. The loser used to be answered `409 CONFLICT` carrying the winner's id, which is the right
    // recovery for a name somebody typed and a wrong one for a name the server invented: the client never sent
    // this name, and the note it is being pointed at is not the note it asked to create (§5.5,
    // `docs/NAME-RULES.md`). So the service re-picks, and four is deliberately more than two: a retry that gave
    // up after one more try would still pass a two-way test.
    const settled = await Promise.allSettled([0, 1, 2, 3].map(() => notes.create({ userId: user.id })));

    const rejected = settled.filter((result) => result.status === 'rejected');
    // Asserting the rejections themselves, so a failure prints the reason rather than a count.
    expect(rejected.map((result) => (result as PromiseRejectedResult).reason)).toStrictEqual([]);

    const names = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value.name] : []));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names).toContain(`new-file-${NOW_MS}`);
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(4);
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

  it('renames and moves in one request, judged in the folder the note lands in', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const from = await folders.create({ userId: user.id, name: 'from' });
    const to = await folders.create({ userId: user.id, name: 'to' });
    const moving = await notes.create({ userId: user.id, name: 'x', folderId: from.id });
    // The name `y` is taken **in the folder the note is leaving** and free in the one it is going to. Two
    // statements — rename, then move — made that a `409`: the rename hit `notes_unique_sib` against `from`, and
    // the re-read that looks for the winner searched `to`, found nothing, and answered with a bare conflict for a
    // request that described a perfectly legal `(to, y)`.
    await notes.create({ userId: user.id, name: 'y', folderId: from.id });

    const patched = await notes.patch({ userId: user.id, id: moving.id, name: 'y', folderId: to.id });

    expect(patched).toMatchObject({ id: moving.id, name: 'y', folderId: to.id, version: 1 });
    const row = await noteById(db, { userId: user.id, id: moving.id });
    expect([row?.name, row?.folderId]).toStrictEqual(['y', to.id]);
    // And the note it used to clash with is untouched: the destination decided, not the source.
    expect((await listAllNotes(db, { userId: user.id })).map((note) => note.name)).toStrictEqual(['y', 'y']);
  });

  it('refuses a name the destination already holds without moving or renaming anything', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const from = await folders.create({ userId: user.id, name: 'from' });
    const to = await folders.create({ userId: user.id, name: 'to' });
    const moving = await notes.create({
      userId: user.id,
      name: 'notes',
      folderId: from.id,
      content: 'one two',
    });
    const taken = await notes.create({ userId: user.id, name: 'notes', folderId: to.id });

    // Same name, different folder: legal where it is, illegal where it is going — and the conflict names the row
    // that won, which is the only recovery the client has.
    const clash = await notes.patch({ userId: user.id, id: moving.id, folderId: to.id }).then(
      () => undefined,
      (thrown: unknown) => thrown as ConflictError,
    );

    expect(clash).toBeInstanceOf(ConflictError);
    expect(clash?.data).toEqual({ id: taken.id });
    // The whole request is absent, not half of it: neither the move nor a rename happened. One statement means
    // there is no half-applied state to observe, whichever half of the request a collision touches.
    const row = await noteById(db, { userId: user.id, id: moving.id });
    expect([row?.name, row?.folderId, row?.version]).toStrictEqual(['notes', from.id, 1]);
    expect(row?.wordCount).toBe(2);
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

    // Started one at a time, on purpose. Written as an array of calls, all three promises are created before the
    // first `await`, so the two later rejections land while nothing is listening for them and Node reports an
    // unhandled rejection — Vitest then exits 1 with every assertion in the file green. Thunks keep "assert this
    // one failed" and "run it" in the same statement, which is what the loop actually means.
    for (const attempt of [
      () => notes.read({ userId: a.id, id: theirs.id }),
      () => notes.patch({ userId: a.id, id: theirs.id, name: 'mine' }),
      () => notes.remove({ userId: a.id, id: theirs.id }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await notes.read({ userId: b.id, id: theirs.id })).content).toBe('not yours');
  });
});

describe('PUT /api/notes/:id/content (§9.2 #18, PR-10 §5)', () => {
  /** The service's answer to a failed write, captured instead of thrown, so the row can be read afterwards. */
  async function failure(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  }

  it('writes once, moves the statistics, and leaves the envelope whole', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'draft', content: 'one two three' });

    const written = await notes.putContent({
      userId: user.id,
      id: created.id,
      content: 'four five\n',
      baseVersion: 1,
    });

    expect(written).toMatchObject({ id: created.id, version: 2, content: 'four five\n', wordCount: 2 });
    expect(written.contentBytes).toBe(Buffer.byteLength('four five\n', 'utf8'));
    // The columns a content write owns, from the row rather than from the response: the version moved exactly one
    // (nothing else moved it), and the byte/word statistics belong to the *plaintext* that is now stored.
    const row = await noteRow(created.id);
    expect([row.version, row.content_bytes, row.word_count]).toEqual([2, 10, 2]);
    expect(Number(row.cipher_bytes)).toBeGreaterThanOrEqual(16);
    expect(Number(row.iv_bytes)).toBe(12);
  });

  it('answers a stale baseVersion with the server state, in the pair PR-14 compares', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'tabs', content: 'shared' });
    // Tab A wins the same version twice; tab B is holding a snapshot from before either write.
    await notes.putContent({ userId: user.id, id: created.id, content: 'the winner', baseVersion: 1 });

    const stale = await failure(
      notes.putContent({ userId: user.id, id: created.id, content: 'the loser', baseVersion: 1 }),
    );

    expect(stale).toBeInstanceOf(VersionConflictError);
    const conflict = stale as VersionConflictError;
    // Both halves, and in `data` — the shape `versionConflictErrorDataSchema` pins and the wire renders as the
    // envelope's payload. The client compares `content` with the exact string it put on the wire: equal means its
    // own write landed and only the reply went missing, so it adopts `version` instead of showing a collision.
    expect([conflict.content, conflict.version]).toEqual(['the winner', 2]);
    expect(conflict.data).toEqual({ content: 'the winner', version: 2 });
    expect(conflict.code).toBe('VERSION_CONFLICT');

    // The loser wrote nothing, in either direction: no second increment, and no trace of its body.
    const row = await noteRow(created.id);
    expect(row.version).toBe(2);
    const current = await notes.read({ userId: user.id, id: created.id });
    expect(current.content).toBe('the winner');
  });

  it("answers a note that is not the caller's with 404, never with the conflict that would confirm it", async () => {
    const a = await createUser(db, { username: 'a', role: 'member' });
    const b = await createUser(db, { username: 'b', role: 'member' });
    const theirs = await notes.create({ userId: b.id, name: 'theirs', content: 'their text' });

    // The conditional update filtered on `user_id` and matched nothing, which is the *same* zero rows a stale
    // `baseVersion` produces. The scoped re-read is what makes this a `404`: a `409` would tell `a` that this uuid
    // is a real note, and `data.content` would hand over a body — the whole point of §5's "never 409".
    const stolen = await failure(
      notes.putContent({ userId: a.id, id: theirs.id, content: 'mine now', baseVersion: 1 }),
    );
    expect(stolen).toBeInstanceOf(NotFoundError);

    const missing = await failure(
      notes.putContent({ userId: a.id, id: theirs.id, content: 'mine now', baseVersion: 99 }),
    );
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((await noteRow(theirs.id)).version).toBe(1);
  });

  it('refuses a violated If-Match before the write, and still says 404 for a note that is not there', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'precondition', content: 'server text' });

    // `baseVersion: 1` matches the row, so the *statement* would have written. The caller's own precondition
    // disagrees with its body, which is enough: the method may only be applied to the state its `If-Match`
    // named, so this is answered from the re-read rather than from the update.
    const violated = await failure(
      notes.putContent({
        userId: user.id,
        id: created.id,
        content: 'written anyway?',
        baseVersion: 1,
        ifMatchAdmitsBase: false,
      }),
    );
    expect(violated).toBeInstanceOf(VersionConflictError);
    expect((violated as VersionConflictError).data).toEqual({ content: 'server text', version: 1 });
    expect((await noteRow(created.id)).version).toBe(1);

    // The same violated precondition with no row behind it is still a `404`: whatever the header said, the
    // existence of an id is decided by the scoped read and by nothing else.
    await notes.remove({ userId: user.id, id: created.id });
    const gone = await failure(
      notes.putContent({
        userId: user.id,
        id: created.id,
        content: 'nobody',
        baseVersion: 1,
        ifMatchAdmitsBase: false,
      }),
    );
    expect(gone).toBeInstanceOf(NotFoundError);
  });

  it('refuses an oversized body before using a key, counting bytes rather than characters', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'cap', content: 'small' });

    const tooLong = 'x'.repeat(NOTE_CONTENT_MAX_BYTES + 1);
    const over = await failure(
      notes.putContent({ userId: user.id, id: created.id, content: tooLong, baseVersion: 1 }),
    );
    expect(over).toBeInstanceOf(PayloadTooLargeError);

    // The cap is a byte cap (`utf8ByteLength`), and a character count would let 1/3 of the note through as three
    // times the storage: `content.length` here is under the cap while the UTF-8 body is not.
    const multibyte = 'あ'.repeat(NOTE_CONTENT_MAX_BYTES / 3 + 1);
    expect(multibyte.length).toBeLessThan(NOTE_CONTENT_MAX_BYTES);
    const overAgain = await failure(
      notes.putContent({ userId: user.id, id: created.id, content: multibyte, baseVersion: 1 }),
    );
    expect(overAgain).toBeInstanceOf(PayloadTooLargeError);

    // Refused before the key was used, so the row still holds the body it had at the version it had it. A write
    // that sealed first and measured second would have spent a round of AES on a body it then threw away, and — if
    // it had also stored it — put a body past the cap in the database that the API then refuses to read back.
    const row = await noteRow(created.id);
    expect([row.version, row.content_bytes, row.word_count]).toEqual([1, 5, 1]);
  });

  it('answers a baseVersion the version column cannot hold from the re-read, not from SQL', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'huge-base', content: 'server text' });

    // `notes.version` is an `int4`. A `baseVersion` past that ceiling is not a stale read — no note was ever at
    // 3_000_000_000 — and it must never reach the statement, because comparing it in the `WHERE` is Postgres
    // `22003` (value out of range), which `mapError()` has no case for: a number the caller invented would come
    // back as `500 INTERNAL`. `noteVersionSchema` refuses it on the wire; this is the same refusal under a caller
    // that reached the service past the schema, and it answers the way a write that matched nothing answers.
    for (const baseVersion of [MAX_NOTE_VERSION + 1, 3_000_000_000]) {
      const stale = await failure(
        notes.putContent({ userId: user.id, id: created.id, content: 'enormous base', baseVersion }),
      );
      expect(stale, String(baseVersion)).toBeInstanceOf(VersionConflictError);
      expect((stale as VersionConflictError).data).toEqual({ content: 'server text', version: 1 });
    }

    // A version that cannot exist cannot belong to a row either, so an id with nothing behind it is still the
    // `404` it has always been — never the conflict that would confirm the note exists.
    await notes.remove({ userId: user.id, id: created.id });
    const gone = await failure(
      notes.putContent({
        userId: user.id,
        id: created.id,
        content: 'enormous base',
        baseVersion: 3_000_000_000,
      }),
    );
    expect(gone).toBeInstanceOf(NotFoundError);
  });

  it('lets an unreadable body fail rather than describe itself as the server state in a 409', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'fragile', content: 'the only copy' });
    await catalogRows(sql`update notes set content_cipher = sha256(content_cipher) where id = ${created.id}`);

    // The write cannot match (`baseVersion: 99` matches nothing), so the answer comes from re-reading the row — and
    // the row no longer authenticates. `EnvelopeError` propagates, which `mapError()` renders as `500`: the
    // alternative is a `409` whose `data.content` is `''`, i.e. a PR-14 that compares its snapshot, sees a
    // difference, and offers to overwrite the one body it cannot currently read. Same rule as `GET` (§7).
    await expect(
      notes.putContent({ userId: user.id, id: created.id, content: 'overwrite?', baseVersion: 99 }),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  it('does not touch the version when the body is the same text again', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const created = await notes.create({ userId: user.id, name: 'unchanged', content: 'same words' });

    // There is no content hash and no "no-op" branch, deliberately: an editor saving identical text is still a new
    // state of the note (its `content_updated_at` moves, and its recents position with it), and skipping the write
    // would make `version` a content hash by the back door — which is exactly the equality `If-Match` cannot
    // promise across a re-serialization.
    const again = await notes.putContent({
      userId: user.id,
      id: created.id,
      content: 'same words',
      baseVersion: 1,
    });
    expect(again.version).toBe(2);
    expect(again.contentBytes).toBe(10);
  });
});
