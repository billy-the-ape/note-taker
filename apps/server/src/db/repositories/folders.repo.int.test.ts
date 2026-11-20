/**
 * The folder repository against Postgres (docs/plans/mvp/MVP-04.md §5/§7).
 *
 * What is proved here is the *tree*, and in particular the three things PR-09 will rely on without re-testing:
 * the root is a real level (`NULL`, folded into `folders_unique_sib` by the `COALESCE` in §8), a sibling name
 * is unique per user, and a delete takes the subtree with it because the foreign keys cascade.
 *
 * The per-user advisory lock and the cycle check are **not** here — PR-09 owns them, because a cycle check
 * outside that lock is a race rather than a guard. `isDescendantOrSelf` is here because the walk it performs is
 * this module's behaviour, and it is tested the way PR-09 will use it.
 */
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUserPair, makeNote, type UserPair } from '../../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../../test/helpers/db.js';
import { expectSqlState } from '../../test/helpers/pg-error.js';
import { sessions, users } from '../schema.js';
import {
  countChildren,
  createFolder,
  deleteFolder,
  folderById,
  folderByParentAndName,
  isDescendantOrSelf,
  listAllFolders,
  listFolders,
  moveFolder,
  renameFolder,
} from './folders.repo.js';

async function pair(): Promise<UserPair> {
  return createUserPair(testDb());
}

/** The folder names of one level, in listing order — an assertion a reader can read. */
async function namesAt(userId: string, parentId: string | null): Promise<string[]> {
  return (await listFolders(testDb(), { userId, parentId })).map((folder) => folder.name);
}

async function countFrom(table: 'folders' | 'notes' | 'sessions' | 'settings' | 'users'): Promise<number> {
  const rows = await catalogRows(sql.raw(`select count(*)::int as total from ${table}`));
  return Number(rows[0]?.total ?? -1);
}

describe('folders.repo', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a root folder whose id came from newId() and whose parent is NULL', async () => {
    const { owner } = await pair();
    const root = await createFolder(testDb(), { userId: owner.id, name: 'Inbox' });

    expect(root.name).toBe('Inbox');
    expect(root.parentId).toBeNull();
    expect(root.userId).toBe(owner.id);
    expect(root.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(root.createdAt).toBeInstanceOf(Date);
    expect(root.updatedAt).toBeInstanceOf(Date);
  });

  it('nests a child under its parent', async () => {
    const { owner } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Work' });
    const child = await createFolder(db, { userId: owner.id, name: 'Q4', parentId: parent.id });

    expect(child.parentId).toBe(parent.id);
    await expect(namesAt(owner.id, null)).resolves.toStrictEqual(['Work']);
    await expect(namesAt(owner.id, parent.id)).resolves.toStrictEqual(['Q4']);
  });

  it('finds a folder by id for its owner, and finds nothing for anyone else', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const created = await createFolder(db, { userId: owner.id, name: 'Private' });

    await expect(folderById(db, { userId: owner.id, id: created.id })).resolves.toMatchObject({
      id: created.id,
    });
    // Someone else's folder is not a 403 with a reason; it is the absence PR-09 renders as a 404.
    await expect(folderById(db, { userId: member.id, id: created.id })).resolves.toBeUndefined();
  });

  it('lists one level at a time, in the order the database itself sorts names', async () => {
    const { owner } = await pair();
    const db = testDb();
    const top = await createFolder(db, { userId: owner.id, name: 'Top' });
    await createFolder(db, { userId: owner.id, name: 'Bravo' });
    await createFolder(db, { userId: owner.id, name: 'alpha' });
    await createFolder(db, { userId: owner.id, name: 'Child', parentId: top.id });
    await createFolder(db, { userId: owner.id, name: '2', parentId: top.id });
    await createFolder(db, { userId: owner.id, name: '1', parentId: top.id });
    await createFolder(db, { userId: owner.id, name: '10', parentId: top.id });

    // The repository must not re-sort. Whatever collation the cluster has, its order is the API's order:
    // PR-16 renders this list, and a JS `sort()` would disagree with the index and with the server. (`C` and
    // `en_US.UTF-8` rank `alpha`/`Bravo` differently, so this compares against the database rather than
    // against a spelling.)
    const listed = await namesAt(owner.id, null);
    const fromDatabase = await catalogRows(
      sql`select name from folders where user_id = ${owner.id} and parent_id is null order by name`,
    );
    expect(listed).toHaveLength(3);
    expect(listed).toStrictEqual(fromDatabase.map((row) => String(row.name)));

    // And one ordering every supported collation agrees on, so the direction is asserted and not assumed:
    // names compare as text digit by digit, which is why `10` follows `1` and precedes `2` in a file tree.
    // The names carry no punctuation on purpose: `-` (0x2D) sorts before `0` (0x30) under `C`, while glibc's
    // `en_US.UTF-8` ignores it at the primary level, so `1-first`/`10-tenth` flipped order with the cluster
    // and turned a `postgres:16-alpine` CI database red. Prefixes and digits-before-letters hold in both.
    await expect(namesAt(owner.id, top.id)).resolves.toStrictEqual(['1', '10', '2', 'Child']);
  });

  it('lists a whole tree, and never another user’s rows', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent' });
    await createFolder(db, { userId: owner.id, name: 'Child', parentId: parent.id });
    await createFolder(db, { userId: member.id, name: 'Theirs' });

    await expect(listAllFolders(db, { userId: owner.id })).resolves.toHaveLength(2);
    await expect(listAllFolders(db, { userId: member.id })).resolves.toHaveLength(1);
  });

  it('looks a sibling up by (user, parent, name), root included', async () => {
    const { owner } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent' });
    const child = await createFolder(db, { userId: owner.id, name: 'Same', parentId: parent.id });
    const root = await createFolder(db, { userId: owner.id, name: 'Same' });

    await expect(
      folderByParentAndName(db, { userId: owner.id, parentId: parent.id, name: 'Same' }),
    ).resolves.toMatchObject({ id: child.id });
    await expect(
      folderByParentAndName(db, { userId: owner.id, parentId: null, name: 'Same' }),
    ).resolves.toMatchObject({ id: root.id });
    await expect(
      folderByParentAndName(db, { userId: owner.id, parentId: null, name: 'Nope' }),
    ).resolves.toBeUndefined();
  });

  it('gives two users the same name in the same place', async () => {
    const { owner, member } = await pair();
    const db = testDb();

    const theirs = await createFolder(db, { userId: member.id, name: 'Scratch' });
    const mine = await createFolder(db, { userId: owner.id, name: 'Scratch' });

    expect(mine.id).not.toBe(theirs.id);
    expect(mine.parentId).toBeNull();
    expect(await namesAt(owner.id, null)).toStrictEqual(['Scratch']);
    expect(await namesAt(member.id, null)).toStrictEqual(['Scratch']);
  });

  it('rejects a duplicate sibling name with 23505 — inside a folder and at the root', async () => {
    const { owner } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent' });
    await createFolder(db, { userId: owner.id, name: 'Notes', parentId: parent.id });
    await createFolder(db, { userId: owner.id, name: 'Notes' });

    // The root case is what `COALESCE` exists for: a plain unique index over a nullable column would let an
    // unlimited number of same-named root folders through, which is the bug §8 calls out.
    await expectSqlState(
      createFolder(db, { userId: owner.id, name: 'Notes' }),
      '23505',
      'folders_unique_sib',
    );
    await expectSqlState(
      createFolder(db, { userId: owner.id, name: 'Notes', parentId: parent.id }),
      '23505',
      'folders_unique_sib',
    );

    expect(await namesAt(owner.id, null)).toStrictEqual(['Notes', 'Parent']);
  });

  it('renames a folder for its owner only', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const created = await createFolder(db, { userId: owner.id, name: 'Before' });

    const renamed = await renameFolder(db, { userId: owner.id, id: created.id, name: 'After' });
    expect(renamed).toMatchObject({ name: 'After', id: created.id });
    expect(renamed?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    await expect(
      renameFolder(db, { userId: member.id, id: created.id, name: 'Not yours' }),
    ).resolves.toBeUndefined();
    await expect(folderById(db, { userId: owner.id, id: created.id })).resolves.toMatchObject({
      name: 'After',
    });
  });

  it('moves a folder, refusing a move that would collide with a sibling', async () => {
    const { owner } = await pair();
    const db = testDb();
    const archive = await createFolder(db, { userId: owner.id, name: 'Archive' });
    const nested = await createFolder(db, { userId: owner.id, name: 'Reports', parentId: archive.id });
    await createFolder(db, { userId: owner.id, name: 'Reports' });

    // The root already holds `Reports`, so this move is a duplicate sibling: the database says so, and PR-09
    // translates it into a 409. The row must be untouched afterwards.
    await expectSqlState(
      moveFolder(db, { userId: owner.id, id: nested.id, parentId: null }),
      '23505',
      'folders_unique_sib',
    );
    await expect(folderById(db, { userId: owner.id, id: nested.id })).resolves.toMatchObject({
      parentId: archive.id,
    });

    // A legal move: sideways into another folder.
    const sideways = await createFolder(db, { userId: owner.id, name: 'Side' });
    const moved = await moveFolder(db, { userId: owner.id, id: nested.id, parentId: sideways.id });
    expect(moved).toMatchObject({ parentId: sideways.id });
    await expect(namesAt(owner.id, sideways.id)).resolves.toStrictEqual(['Reports']);
  });

  it('deletes a folder and its whole subtree, notes included (ON DELETE CASCADE)', async () => {
    const { owner } = await pair();
    const db = testDb();
    const root = await createFolder(db, { userId: owner.id, name: 'Root' });
    const keep = await createFolder(db, { userId: owner.id, name: 'Keep' });
    const branch = await createFolder(db, { userId: owner.id, name: 'Branch', parentId: root.id });
    const leaf = await createFolder(db, { userId: owner.id, name: 'Leaf', parentId: branch.id });
    await makeNote(db, owner.id, { name: 'in-leaf.md', folderId: leaf.id });
    await makeNote(db, owner.id, { name: 'at-root.md', folderId: null });

    await expect(deleteFolder(db, { userId: owner.id, id: branch.id })).resolves.toBe(true);

    expect(await namesAt(owner.id, null)).toStrictEqual(['Keep', 'Root']);
    await expect(folderById(db, { userId: owner.id, id: leaf.id })).resolves.toBeUndefined();
    // The note two levels down went with it; the one at the root stayed.
    const notes = await catalogRows(sql`select name from notes where user_id = ${owner.id} order by name`);
    expect(notes.map((row) => String(row.name))).toStrictEqual(['at-root.md']);

    // Deleting something that is gone (or never yours) answers `false` instead of throwing.
    await expect(deleteFolder(db, { userId: owner.id, id: branch.id })).resolves.toBe(false);
    expect(await countChildren(db, { userId: owner.id, parentId: keep.id })).toBe(0);
  });

  it('cascades a deleted user to every row that hangs off them', async () => {
    const { owner } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent' });
    await createFolder(db, { userId: owner.id, name: 'Child', parentId: parent.id });
    await makeNote(db, owner.id, { name: 'note.md', folderId: parent.id });
    await db
      .insert(sessions)
      .values({ tokenHash: new Uint8Array(32), userId: owner.id, expiresAt: new Date(Date.now() + 60_000) });

    await db.delete(users).where(eq(users.id, owner.id));

    // One row of the second user's survives, which is what makes the zeros below a fact about cascades.
    expect(await countFrom('users')).toBe(1);
    expect(await countFrom('folders')).toBe(0);
    expect(await countFrom('notes')).toBe(0);
    expect(await countFrom('sessions')).toBe(0);
    // …and it is the *other* user's settings row that survives, so the zeros above are about cascades.
    expect(await countFrom('settings')).toBe(1);
  });

  it('answers PR-09’s cycle question by walking ancestors (isDescendantOrSelf)', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const grandparent = await createFolder(db, { userId: owner.id, name: 'Grandparent' });
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent', parentId: grandparent.id });
    const child = await createFolder(db, { userId: owner.id, name: 'Child', parentId: parent.id });
    const cousin = await createFolder(db, { userId: owner.id, name: 'Cousin', parentId: grandparent.id });
    const theirs = await createFolder(db, { userId: member.id, name: 'Theirs' });

    // Moving `parent` under `child` would close a loop, so the walk says yes before any write happens.
    await expect(
      isDescendantOrSelf(db, { userId: owner.id, id: parent.id, targetId: child.id }),
    ).resolves.toBe(true);
    await expect(
      isDescendantOrSelf(db, { userId: owner.id, id: parent.id, targetId: parent.id }),
    ).resolves.toBe(true);
    // A cousin, or a move up towards the root, is fine — and a folder that is not this user's is not a
    // descendant either, because the walk is scoped and simply stops.
    await expect(
      isDescendantOrSelf(db, { userId: owner.id, id: parent.id, targetId: cousin.id }),
    ).resolves.toBe(false);
    await expect(
      isDescendantOrSelf(db, { userId: owner.id, id: child.id, targetId: grandparent.id }),
    ).resolves.toBe(false);
    await expect(
      isDescendantOrSelf(db, { userId: owner.id, id: parent.id, targetId: theirs.id }),
    ).resolves.toBe(false);
  });

  it('counts the children of one level only', async () => {
    const { owner, member } = await pair();
    const db = testDb();
    const parent = await createFolder(db, { userId: owner.id, name: 'Parent' });
    await createFolder(db, { userId: owner.id, name: 'A', parentId: parent.id });
    await createFolder(db, { userId: owner.id, name: 'B', parentId: parent.id });
    await createFolder(db, { userId: owner.id, name: 'Root-level' });

    expect(await countChildren(db, { userId: owner.id, parentId: parent.id })).toBe(2);
    // The root level holds `Parent` and `Root-level` — `A`/`B` are one level down and are not counted here.
    expect(await countChildren(db, { userId: owner.id, parentId: null })).toBe(2);
    expect(await countChildren(db, { userId: member.id, parentId: null })).toBe(0);
  });
});
