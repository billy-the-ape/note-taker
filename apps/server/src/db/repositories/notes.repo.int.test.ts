/**
 * The note repository against Postgres (docs/plans/mvp/MVP-04.md §5/§7).
 *
 * Two things are proved, and the second is the one that keeps PR-10 honest:
 *
 * 1. **The content triple is opaque.** The repository is handed `content_cipher`/`content_iv`/`key_version`
 *    already sealed (here: fixed test blobs, later: `crypto/envelope.ts` from PR-06) and gives the same bytes
 *    back, because nothing in `src/db` looks inside them or could store plaintext.
 * 2. **`version` is optimistic concurrency.** The update compares the caller's base version and bumps it in the
 *    same statement, so a stale write matches zero rows and two writers starting from one version cannot both
 *    win. PR-10 turns "zero rows" into a `409`; it may not have to discover that the column drifts.
 */
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUserPair, makeNote, sealedContent, type UserPair } from '../../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../../test/helpers/db.js';
import { expectSqlState } from '../../test/helpers/pg-error.js';
import { type Note, notes } from '../schema.js';
import { createFolder, deleteFolder } from './folders.repo.js';
import {
  contentUpdateStatement,
  createNote,
  deleteNote,
  likeContainsPattern,
  listAllNotes,
  listNotes,
  noteByFolderAndName,
  noteById,
  patchNote,
  recentNotes,
  searchNotesByMetadata,
  writeNoteContent,
} from './notes.repo.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

async function pair(): Promise<UserPair> {
  return createUserPair(testDb());
}

function namesOf(rows: readonly Note[]): string[] {
  return rows.map((row) => row.name);
}

describe('notes.repo', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a note from the triple it was handed, with §8 defaults either side of the ciphertext', async () => {
    const { owner } = await pair();
    const content = {
      contentCipher: bytes(1, 2, 3, 4),
      contentIv: bytes(9, 8, 7),
      keyVersion: 1,
      contentBytes: 4,
      wordCount: 1,
    };

    const note = await createNote(testDb(), { userId: owner.id, name: 'first.md', content });

    expect(note.version).toBe(1);
    expect(note.keyVersion).toBe(1);
    expect(note.contentFormat).toBe('markdown');
    expect(note.contentBytes).toBe(4);
    expect(note.wordCount).toBe(1);
    expect(note.folderId).toBeNull();
    // The bytes came back exactly: no re-encoding, no truncation, no Buffer-vs-Uint8Array surprise.
    expect(Array.from(note.contentCipher)).toStrictEqual([1, 2, 3, 4]);
    expect(Array.from(note.contentIv)).toStrictEqual([9, 8, 7]);
    expect(note.contentUpdatedAt).toBeInstanceOf(Date);
  });

  it('round-trips arbitrary bytes, including a byte that is not valid UTF-8', async () => {
    const { owner } = await pair();
    const db = testDb();
    // Ciphertext is not text: 0xff is not the start of any UTF-8 sequence, so a column that quietly went
    // through `text` would corrupt exactly this.
    const raw = new Uint8Array([0, 255, 128, 127, 10, 13, 0, 60]);

    const created = await createNote(db, {
      userId: owner.id,
      name: 'bytes.md',
      content: {
        contentCipher: raw,
        contentIv: new Uint8Array(12).fill(7),
        keyVersion: 1,
        contentBytes: raw.byteLength,
        wordCount: 0,
      },
    });
    const loaded = await noteById(db, { userId: owner.id, id: created.id });

    expect(Array.from(loaded?.contentCipher ?? [])).toStrictEqual(Array.from(raw));
    expect(loaded?.contentIv.byteLength).toBe(12);
    expect(loaded?.contentBytes).toBe(raw.byteLength);
  });

  it('keeps one name per (user, folder), root included, and none between users', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const folder = await createFolder(db, { userId: owner.id, name: 'Folder' });
    await makeNote(db, owner.id, { name: 'same.md', folderId: folder.id });
    await makeNote(db, owner.id, { name: 'same.md', folderId: null });

    await expectSqlState(
      makeNote(db, owner.id, { name: 'same.md', folderId: folder.id }),
      '23505',
      'notes_unique_sib',
    );
    // The root half of `notes_unique_sib` again: same-name root notes are one name.
    await expectSqlState(
      makeNote(db, owner.id, { name: 'same.md', folderId: null }),
      '23505',
      'notes_unique_sib',
    );
    // A different folder, or a different person, is a different note.
    const other = await createFolder(db, { userId: owner.id, name: 'Other' });
    await expect(makeNote(db, owner.id, { name: 'same.md', folderId: other.id })).resolves.toMatchObject({
      folderId: other.id,
    });
    await expect(makeNote(db, member.id, { name: 'same.md', folderId: null })).resolves.toBeDefined();
  });

  it('lists one folder, the root, and a whole account — never a second account', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const folder = await createFolder(db, { userId: owner.id, name: 'Folder' });
    await makeNote(db, owner.id, { name: 'b.md', folderId: folder.id });
    await makeNote(db, owner.id, { name: 'a.md', folderId: folder.id });
    await makeNote(db, owner.id, { name: 'root.md', folderId: null });
    await makeNote(db, member.id, { name: 'theirs.md' });

    await expect(listNotes(db, { userId: owner.id, folderId: folder.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'a.md' })]),
    );
    expect(await namesOf(await listNotes(db, { userId: owner.id, folderId: folder.id }))).toStrictEqual([
      'a.md',
      'b.md',
    ]);
    expect(await namesOf(await listNotes(db, { userId: owner.id, folderId: null }))).toStrictEqual([
      'root.md',
    ]);
    expect(await namesOf(await listAllNotes(db, { userId: owner.id }))).toStrictEqual([
      'a.md',
      'b.md',
      'root.md',
    ]);
    expect(await listAllNotes(db, { userId: member.id })).toHaveLength(1);
  });

  it('looks a sibling up by (user, folder, name), root included', async () => {
    const { owner } = await pair();
    const db = testDb();
    const folder = await createFolder(db, { userId: owner.id, name: 'Folder' });
    const inside = await makeNote(db, owner.id, { name: 'inside.md', folderId: folder.id });
    const atRoot = await makeNote(db, owner.id, { name: 'root.md' });

    await expect(
      noteByFolderAndName(db, { userId: owner.id, folderId: folder.id, name: 'inside.md' }),
    ).resolves.toMatchObject({ id: inside.id });
    await expect(
      noteByFolderAndName(db, { userId: owner.id, folderId: null, name: 'root.md' }),
    ).resolves.toMatchObject({ id: atRoot.id });
    await expect(
      noteByFolderAndName(db, { userId: owner.id, folderId: null, name: 'gone.md' }),
    ).resolves.toBeUndefined();
  });

  it('returns recent notes newest-first, capped, which is notes_user_content_updated_idx', async () => {
    const { owner } = await pair();
    const db = testDb();
    const first = await makeNote(db, owner.id, { name: 'first.md' });
    const second = await makeNote(db, owner.id, { name: 'second.md' });
    const third = await makeNote(db, owner.id, { name: 'third.md' });
    // Move the oldest to the front of the list the way a content write would: by `content_updated_at`.
    await db
      .update(notes)
      .set({ contentUpdatedAt: new Date(Date.now() + 5_000) })
      .where(eq(notes.id, first.id));

    const recent = await recentNotes(db, { userId: owner.id, limit: 2 });
    // Only the bumped note has a defined rank: the other two were written in the same millisecond, and the
    // tie is broken by id, which is UUIDv7-ordered only to millisecond precision.
    expect(recent.map((note) => note.name)[0]).toBe('first.md');
    expect(recent).toHaveLength(2);
    expect([second.id, third.id]).toContain(recent[1]?.id);
    expect(recent[0]?.id).toBe(first.id);
    expect(second.version).toBe(1);

    const all = await recentNotes(db, { userId: owner.id });
    expect(all).toHaveLength(3);
  });

  it('renames and moves a note, refusing the move a sibling still occupies', async () => {
    const { owner } = await pair();
    const db = testDb();
    const folder = await createFolder(db, { userId: owner.id, name: 'Folder' });
    const atRoot = await makeNote(db, owner.id, { name: 'unique.md', folderId: null });
    const inside = await makeNote(db, owner.id, { name: 'unique.md', folderId: folder.id });

    // One name in both places, so `unique.md` cannot move up: the sibling index decides, not the repository,
    // and PR-09 renders the failure as a 409. The row must still be where it was.
    await expectSqlState(
      patchNote(db, { userId: owner.id, id: inside.id, folderId: null }),
      '23505',
      'notes_unique_sib',
    );
    await expect(noteById(db, { userId: owner.id, id: inside.id })).resolves.toMatchObject({
      folderId: folder.id,
    });

    // Rename the root note and the very same move becomes legal: the constraint was the collision, nothing else.
    const renamed = await patchNote(db, { userId: owner.id, id: atRoot.id, name: 'renamed.md' });
    expect(renamed).toMatchObject({ name: 'renamed.md', version: 1 });

    const moved = await patchNote(db, { userId: owner.id, id: inside.id, folderId: null });
    expect(moved).toMatchObject({ folderId: null, id: inside.id });
    // Renames and moves never touch `version`: only a content write is a new version, which is what lets a
    // rename happen without invalidating every open editor (PR-10's 409 depends on that).
    expect(moved?.version).toBe(1);
    expect(namesOf(await listNotes(db, { userId: owner.id, folderId: null }))).toStrictEqual([
      'renamed.md',
      'unique.md',
    ]);
  });

  it('renames and moves in one statement, which is the pair the sibling index judges', async () => {
    const { owner } = await pair();
    const db = testDb();
    const from = await createFolder(db, { userId: owner.id, name: 'from' });
    const to = await createFolder(db, { userId: owner.id, name: 'to' });
    const moving = await makeNote(db, owner.id, { name: 'a', folderId: from.id });
    // A note called `b` already sits in the folder `moving` is leaving. Renaming first and moving afterwards —
    // what `PATCH /api/notes/:id` used to do — hit `notes_unique_sib` here, in a folder the note was on its way
    // out of, and the request that described a perfectly legal `(to, b)` was refused.
    await makeNote(db, owner.id, { name: 'b', folderId: from.id });

    const patched = await patchNote(db, { userId: owner.id, id: moving.id, name: 'b', folderId: to.id });

    expect(patched).toMatchObject({ name: 'b', folderId: to.id, version: 1 });
    expect(namesOf(await listNotes(db, { userId: owner.id, folderId: from.id }))).toStrictEqual(['b']);
    expect(namesOf(await listNotes(db, { userId: owner.id, folderId: to.id }))).toStrictEqual(['b']);
  });

  it('builds the conditional update the contract asks for: WHERE id AND version, RETURNING *', () => {
    const statement = contentUpdateStatement(testDb(), {
      userId: 'user-id',
      noteId: 'note-id',
      baseVersion: 7,
      content: sealedContent('replacement'),
    });
    const { sql: text, params } = statement.toSQL();

    expect(text).toMatch(/update "notes" set/i);
    // The three predicates §7 requires, in one statement: the note, the version the caller read, and the owner.
    expect(text).toMatch(/"notes"\."id" = \$\d+/);
    expect(text).toMatch(/"notes"\."version" = \$\d+/);
    expect(text).toMatch(/"notes"\."user_id" = \$\d+/);
    // Drizzle expands `RETURNING *` into the column list, so the assertion is the fact rather than the spelling:
    // the whole updated row comes back, `version` included — it is what PR-10 hands the client as the new base
    // version, and `content_cipher` coming back is why no follow-up select is needed.
    expect(text).toMatch(/returning "id", "user_id", "folder_id"/);
    expect(text).toMatch(/returning [\s\S]*"version"/);
    expect(text).toMatch(/returning [\s\S]*"content_cipher"/);
    // `version` is bumped by the statement itself, never read-modified-written by the caller.
    expect(text).toMatch(/"version" = .*"notes"\."version" \+ 1/i);
    expect(params).toContain(7);
  });

  it('writes a new version when the base version is current, and nothing when it is stale', async () => {
    const { owner } = await pair();
    const db = testDb();
    const note = await makeNote(db, owner.id, { name: 'draft.md', text: 'first draft' });
    const replacement = {
      contentCipher: bytes(42, 43),
      contentIv: bytes(1, 2, 3),
      keyVersion: 1,
      contentBytes: 11,
      wordCount: 2,
    };

    const written = await writeNoteContent(db, {
      userId: owner.id,
      noteId: note.id,
      baseVersion: note.version,
      content: replacement,
    });

    expect(written).toBeDefined();
    expect(written?.version).toBe(2);
    expect(Array.from(written?.contentCipher ?? [])).toStrictEqual([42, 43]);
    expect(written?.contentBytes).toBe(11);
    expect(written?.wordCount).toBe(2);
    expect((written?.contentUpdatedAt.getTime() ?? 0) >= note.contentUpdatedAt.getTime()).toBe(true);

    // The stale write: same note, same bytes, the version the *first* writer started from. PR-10's 409.
    const stale = await writeNoteContent(db, {
      userId: owner.id,
      noteId: note.id,
      baseVersion: note.version,
      content: { ...replacement, contentBytes: 12 },
    });
    expect(stale).toBeUndefined();
    await expect(noteById(db, { userId: owner.id, id: note.id })).resolves.toMatchObject({
      version: 2,
      contentBytes: 11,
    });
  });

  it('lets exactly one of two concurrent writers starting from the same version win', async () => {
    const { owner } = await pair();
    const db = testDb();
    const note = await makeNote(db, owner.id, { name: 'race.md' });

    const attempt = (label: string) =>
      writeNoteContent(db, {
        userId: owner.id,
        noteId: note.id,
        baseVersion: note.version,
        content: sealedContent(label),
      });

    const writes = await Promise.all([attempt('writer-a'), attempt('writer-b'), attempt('writer-c')]);
    const winners = writes.filter((write) => write !== undefined);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.version).toBe(2);
    const current = await noteById(db, { userId: owner.id, id: note.id });
    expect(current?.version).toBe(2);
    // The row that stands is the winner's: the loser's bytes never landed, and nothing was merged.
    expect(Array.from(current?.contentCipher ?? [])).toStrictEqual(
      Array.from(winners[0]?.contentCipher ?? []),
    );
  });

  it('does not let one user write into another’s note, and does not resurrect a deleted one', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const note = await makeNote(db, owner.id, { name: 'theirs.md' });

    const denied = await writeNoteContent(db, {
      userId: member.id,
      noteId: note.id,
      baseVersion: note.version,
      content: sealedContent('not mine'),
    });
    expect(denied).toBeUndefined();

    await expect(deleteNote(db, { userId: member.id, id: note.id })).resolves.toBe(false);
    await expect(deleteNote(db, { userId: owner.id, id: note.id })).resolves.toBe(true);
    await expect(deleteNote(db, { userId: owner.id, id: note.id })).resolves.toBe(false);
    await expect(noteById(db, { userId: owner.id, id: note.id })).resolves.toBeUndefined();

    // A write to a note that is gone matches nothing, whatever version is offered.
    await expect(
      writeNoteContent(db, {
        userId: owner.id,
        noteId: note.id,
        baseVersion: 1,
        content: sealedContent('ghost'),
      }),
    ).resolves.toBeUndefined();
  });

  it('deletes a note through a folder cascade too, so the counters never count another row', async () => {
    const { owner } = await pair();
    const db = testDb();
    const folder = await createFolder(db, { userId: owner.id, name: 'Folder' });
    await makeNote(db, owner.id, { name: 'one.md', folderId: folder.id });
    await makeNote(db, owner.id, { name: 'two.md', folderId: folder.id });

    await expect(deleteFolder(db, { userId: owner.id, id: folder.id })).resolves.toBe(true);

    const remaining = await catalogRows(
      sql`select count(*)::int as total from notes where user_id = ${owner.id}`,
    );
    expect(Number(remaining[0]?.total)).toBe(0);
    expect(await listNotes(db, { userId: owner.id, folderId: folder.id })).toStrictEqual([]);
  });

  it('searches metadata with `%` and `_` literal in **both** halves of the predicate (PR-11)', async () => {
    const db = testDb();
    const { owner } = await pair();
    const underscore = await createFolder(db, { userId: owner.id, name: 'a_b' });
    const xletter = await createFolder(db, { userId: owner.id, name: 'axb' });

    await makeNote(db, owner.id, { name: '100% cotton' });
    await makeNote(db, owner.id, { name: 'a_b note' });
    await makeNote(db, owner.id, { name: 'axb note' });
    await makeNote(db, owner.id, { name: 'plain' });
    // Two rows whose **names** cannot match, so what follows can only be answered by the folder half — a second
    // `LIKE … ESCAPE` living inside the `exists` subquery, escaped separately and able to break separately.
    await makeNote(db, owner.id, { name: 'inside-underscore', folderId: underscore.id });
    await makeNote(db, owner.id, { name: 'inside-xletter', folderId: xletter.id });

    const searchBy = async (q: string): Promise<string[]> => {
      const rows = await searchNotesByMetadata(db, {
        userId: owner.id,
        pattern: likeContainsPattern(q),
        // The scan bound the service passes; the corpus is six rows, so this number decides nothing here.
        limit: 500,
      });
      return rows.map((row) => row.name).sort();
    };

    // The control: the statement is matching *something*, so an empty or short answer below means "literal".
    expect(await searchBy('note')).toStrictEqual(['a_b note', 'axb note']);

    // Unescaped, `100%` would become `%%%` (the whole corpus) and `a_b` would reach `axb note`; an ESCAPE clause
    // that Postgres reads as empty turns both queries into searches for a literal backslash, which is nothing.
    expect(await searchBy('100%')).toStrictEqual(['100% cotton']);
    expect(await searchBy('%')).toStrictEqual(['100% cotton']);
    expect(await searchBy('a_b')).toStrictEqual(['a_b note', 'inside-underscore']);
    expect(await searchBy('_')).toStrictEqual(['a_b note', 'inside-underscore']);
  });

  it('returns name matches before folder matches, so its row bound cannot cut a name hit (PR-11)', async () => {
    const db = testDb();
    const { owner } = await pair();
    const work = await createFolder(db, { userId: owner.id, name: 'work' });
    for (const letter of ['a', 'b', 'c', 'd']) {
      await makeNote(db, owner.id, { name: `inside-${letter}`, folderId: work.id });
    }
    await makeNote(db, owner.id, { name: 'work plan' });
    // The one row whose **name** matches is also the oldest row in the corpus, so a `limit` ordered by recency
    // alone would keep the four folder matches and drop it (PR-11 review, inline `r4722272755`).
    await catalogRows(
      sql`update notes
             set content_updated_at = '2020-01-01T00:00:00Z'::timestamptz
           where user_id = ${owner.id} and name = 'work plan'`,
    );

    const searchBy = async (limit: number) => {
      const rows = await searchNotesByMetadata(db, {
        userId: owner.id,
        pattern: likeContainsPattern('work'),
        limit,
      });
      return rows.map((row) => `${row.name}:${String(row.nameMatched)}`);
    };

    // The bound is a bound on *matching rows*, and the tier ordering is what makes it harmless: the cut falls on
    // rows the endpoint would have ranked below the ones it kept, never on the name hit. The folder rows' internal
    // order is deliberately not asserted — they were written in one millisecond or several, and only the tier is
    // the subject here.
    expect(await searchBy(1)).toStrictEqual(['work plan:true']);

    const topThree = await searchBy(3);
    expect(topThree[0]).toBe('work plan:true');
    expect(topThree).toHaveLength(3);
    expect(topThree.slice(1).every((row) => row.endsWith(':false'))).toBe(true);

    const everything = await searchBy(5);
    expect(everything.filter((row) => row.endsWith(':true'))).toStrictEqual(['work plan:true']);
    expect(everything).toHaveLength(5);
  });
});
