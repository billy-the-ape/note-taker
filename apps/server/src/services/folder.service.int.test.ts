/**
 * `services/folder.service.ts` over a real Postgres (docs/plans/mvp/MVP-09.md §5.2–§5.4, §7).
 *
 * This file exists for three claims that cannot be made about a folder service in a unit test, because all three
 * are properties of Postgres rather than of TypeScript:
 *
 * * the two recursive walks (`folders.repo.ts`'s ancestor walk and its subtree-height walk) agree with each other
 *   and with a chain a human can count, at **depth 99**, where the CTE guard starts cutting;
 * * the per-user `pg_advisory_xact_lock` really does serialise two concurrent moves, including the four-folder
 *   disjoint-pair case that a design locking "the moved folder and its new parent" lets through (§5.3);
 * * `on delete cascade` removes a whole subtree with one statement, so the service's `remove` is one delete and not
 *   a walk that can half-finish.
 *
 * Everything here calls the service, never a repository: the point is the *combination* of lock, walk, and insert,
 * and a test that reproduced the service's order of calls would be testing its own copy.
 */
import { FOLDER_MAX_DEPTH, type FolderNode } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getKeyring } from '../crypto/keys.js';
import { listAllFolders } from '../db/repositories/folders.repo.js';
import { listAllNotes } from '../db/repositories/notes.repo.js';
import type { Folder } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { createUser } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { createFolderService } from './folder.service.js';
import { createNoteService } from './note.service.js';
import { createTreeService } from './tree.service.js';

const db = testDb();
const folders = createFolderService({ db });
const tree = createTreeService({ db });
/** Only the cascade test needs a real note, and a real note needs the process keyring. */
const notes = createNoteService({ db, keyring: getKeyring() });

/** `FOLDER_MAX_DEPTH` is the deepest *legal* depth, so the cap is one more than it. */
const CAP = FOLDER_MAX_DEPTH + 1;

beforeEach(async () => {
  await resetDb();
});

/** Two people, because every cross-user case in §7 needs a second one. */
async function twoUsers() {
  const a = await createUser(db, { username: 'a', role: 'member' });
  const b = await createUser(db, { username: 'b', role: 'member' });
  return { a, b };
}

/**
 * A chain of `levels` folders under `parentId` (root folder = depth 0 when `parentId` is `null`), created through
 * the service so the cap is exercised on the way in as well as asserted on the way out.
 */
async function makeChain(
  userId: string,
  levels: number,
  options: { readonly parentId?: string | null; readonly prefix?: string } = {},
): Promise<FolderNode[]> {
  const prefix = options.prefix ?? 'lvl';
  const created: FolderNode[] = [];
  let parentId = options.parentId ?? null;
  for (let level = 0; level < levels; level += 1) {
    const folder = await folders.create({ userId, name: `${prefix}${level}`, parentId });
    created.push(folder);
    parentId = folder.id;
  }
  return created;
}

/** `rows → id → parent_id`, read with a statement no repository owns, so a service cannot flatter itself. */
async function parentOf(): Promise<Map<string, string | null>> {
  const rows = await catalogRows(sql`select id, parent_id from folders`);
  return new Map(rows.map((row) => [String(row.id), row.parent_id === null ? null : String(row.parent_id)]));
}

/** Every folder of the user, `id → parentId`, straight from the table. */
async function snapshot(userId: string): Promise<Map<string, string | null>> {
  const rows = await listAllFolders(db, { userId });
  return new Map(rows.map((row: Folder) => [row.id, row.parentId]));
}

describe('folder create (§4 #13, §5.2)', () => {
  it('nests three levels deep and reports the parent each time', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const root = await folders.create({ userId: user.id, name: 'top' });
    const second = await folders.create({ userId: user.id, name: 'mid', parentId: root.id });
    const third = await folders.create({ userId: user.id, name: 'leaf', parentId: second.id });

    expect(root.parentId).toBeNull();
    expect(second.parentId).toBe(root.id);
    expect(third.parentId).toBe(second.id);

    const parents = await parentOf();
    expect(parents.get(third.id)).toBe(second.id);
    expect(parents.size).toBe(3);

    // The CTE walk and the inserted rows agree, which is what makes the depth assertions below worth anything.
    const walked = await tree.get({ userId: user.id });
    expect(walked.folders.map((folder) => folder.id).sort()).toEqual([root.id, second.id, third.id].sort());
  });

  it('refuses to create a folder below the deepest legal depth, naming the cap', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const chain = await makeChain(user.id, CAP);
    expect(chain).toHaveLength(CAP);
    const deepest = chain[CAP - 1];
    if (!deepest) throw new Error('the chain did not reach the cap');

    const attempt = folders.create({ userId: user.id, name: 'one-too-deep', parentId: deepest.id });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);

    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as ValidationError,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.message).toContain(String(CAP));
    expect(error?.code).toBe('VALIDATION');
    // An error, not a silent drop: the tree is exactly as it was.
    const after = await tree.get({ userId: user.id });
    expect(after.folders).toHaveLength(CAP);
  });

  it('lets a folder land exactly at the deepest legal depth', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const chain = await makeChain(user.id, CAP - 1);
    const parent = chain[CAP - 2];
    if (!parent) throw new Error('the chain is one folder short of the pre-cap depth');

    const legal = await folders.create({ userId: user.id, name: 'last-one', parentId: parent.id });
    const walked = await tree.get({ userId: user.id });
    expect(walked.folders).toHaveLength(CAP);
    expect(walked.folders.some((folder) => folder.id === legal.id)).toBe(true);
  });
});

describe('folder rename and move (§4 #14, §5.2, §5.5)', () => {
  it("answers a rename into an occupied sibling name with the winner's id", async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const parent = await folders.create({ userId: user.id, name: 'parent' });
    const taken = await folders.create({ userId: user.id, name: 'docs', parentId: parent.id });
    const other = await folders.create({ userId: user.id, name: 'notes', parentId: parent.id });

    const attempt = folders.patch({ userId: user.id, id: other.id, name: 'docs' });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);

    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as ConflictError,
    );
    // §9.1: the id is in `data`, because "the name is taken" is only actionable if the client can reach the row.
    expect(error?.data).toEqual({ id: taken.id });
    expect(error?.details?.[0]?.path).toBe('name');

    const parents = await snapshot(user.id);
    expect(parents.get(other.id)).toBe(parent.id);
    const renamed = await listAllFolders(db, { userId: user.id });
    expect(renamed.find((folder) => folder.id === other.id)?.name).toBe('notes');
  });

  it('treats a no-op rename, and a move to the folder it is already in, as success', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const parent = await folders.create({ userId: user.id, name: 'parent' });
    const child = await folders.create({ userId: user.id, name: 'child', parentId: parent.id });

    const sameName = await folders.patch({ userId: user.id, id: child.id, name: 'child' });
    expect(sameName.name).toBe('child');
    const sameParent = await folders.patch({ userId: user.id, id: child.id, parentId: parent.id });
    expect(sameParent.parentId).toBe(parent.id);
    expect((await snapshot(user.id)).size).toBe(2);
  });

  it('rejects moving a folder under its own child, and into itself', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const a = await folders.create({ userId: user.id, name: 'A' });
    const b = await folders.create({ userId: user.id, name: 'B', parentId: a.id });
    const c = await folders.create({ userId: user.id, name: 'C', parentId: b.id });

    await expect(folders.patch({ userId: user.id, id: a.id, parentId: c.id })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(folders.patch({ userId: user.id, id: a.id, parentId: b.id })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(folders.patch({ userId: user.id, id: b.id, parentId: b.id })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const parents = await snapshot(user.id);
    expect(parents.get(a.id)).toBeNull();
    expect(parents.get(b.id)).toBe(a.id);
    expect(parents.get(c.id)).toBe(b.id);
  });

  it('moves a subtree between roots and back, keeping its children', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const x = await folders.create({ userId: user.id, name: 'x' });
    const y = await folders.create({ userId: user.id, name: 'y' });
    const under = await folders.create({ userId: user.id, name: 'under', parentId: x.id });

    const moved = await folders.patch({ userId: user.id, id: x.id, parentId: y.id });
    expect(moved.parentId).toBe(y.id);
    const parents = await snapshot(user.id);
    expect(parents.get(under.id)).toBe(x.id);

    const back = await folders.patch({ userId: user.id, id: x.id, parentId: null });
    expect(back.parentId).toBeNull();
  });

  it('renames and moves in one request', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const from = await folders.create({ userId: user.id, name: 'from' });
    const to = await folders.create({ userId: user.id, name: 'to' });
    const folder = await folders.create({ userId: user.id, name: 'kid', parentId: from.id });

    const patched = await folders.patch({ userId: user.id, id: folder.id, name: 'moved', parentId: to.id });
    expect([patched.name, patched.parentId]).toEqual(['moved', to.id]);
  });

  it('refuses a move whose subtree would land below the cap, even though the destination is a root', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    // `carrying` is a root folder whose tail already sits at the deepest legal depth (levels 0…99).
    const carrying = await folders.create({ userId: user.id, name: 'carrying' });
    const chain = await makeChain(user.id, CAP - 1, { parentId: carrying.id, prefix: 'tail' });
    expect(chain).toHaveLength(CAP - 1);
    const other = await folders.create({ userId: user.id, name: 'other-root' });

    // The upward walk alone sees `other` at depth 0 and would pass this; the height of what `carrying` drags
    // behind it is what makes the answer no (§5.2).
    const attempt = folders.patch({ userId: user.id, id: carrying.id, parentId: other.id });
    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as unknown,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain(String(CAP));

    // Byte-identical afterwards: one parent changed, and it is not this one.
    const parents = await snapshot(user.id);
    expect(parents.get(carrying.id)).toBeNull();
    const walked = await tree.get({ userId: user.id });
    expect(walked.folders).toHaveLength(CAP + 1);
  });
});

describe('folder delete (§4 #15)', () => {
  it('refuses a non-empty folder without cascade, then deletes the whole subtree with it', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const top = await folders.create({ userId: user.id, name: 'top' });
    const nested = await folders.create({ userId: user.id, name: 'nested', parentId: top.id });
    await notes.create({ userId: user.id, name: 'in-nested', folderId: nested.id });
    await notes.create({ userId: user.id, name: 'in-top', folderId: top.id });

    const refused = folders.remove({ userId: user.id, id: top.id, cascade: false });
    const error = await refused.then(
      () => undefined,
      (thrown: unknown) => thrown as ConflictError,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error?.message).toContain('cascade');
    expect((await snapshot(user.id)).size).toBe(2);

    await folders.remove({ userId: user.id, id: top.id, cascade: true });

    const left = await snapshot(user.id);
    expect(left.has(top.id)).toBe(false);
    expect(left.has(nested.id)).toBe(false);
    // §7: the cascade takes the note rows with it — and their ciphertext rows are the same rows.
    expect(await listAllNotes(db, { userId: user.id })).toHaveLength(0);
  });

  it('deletes an empty folder in one statement', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const folder = await folders.create({ userId: user.id, name: 'empty' });
    await folders.remove({ userId: user.id, id: folder.id, cascade: false });
    expect((await snapshot(user.id)).size).toBe(0);
  });

  it("answers 404-shaped NotFound for a folder that is not the caller's", async () => {
    const { a, b } = await twoUsers();
    const theirs = await folders.create({ userId: b.id, name: 'theirs' });

    // Thunks, for the reason the notes suite spells out: an array of calls would start all three at once, and the
    // rejections that arrive before their `expect` are unhandled rejections rather than passing assertions.
    for (const attempt of [
      () => folders.patch({ userId: a.id, id: theirs.id, name: 'mine-now' }),
      () => folders.patch({ userId: a.id, id: theirs.id, parentId: null }),
      () => folders.remove({ userId: a.id, id: theirs.id, cascade: true }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    // Their row is untouched, and the attempt did not leave a partial write behind.
    const parents = await snapshot(b.id);
    expect(parents.get(theirs.id)).toBeNull();
    expect(parents.has(theirs.id)).toBe(true);
  });
});

describe('cross-user ids in bodies (§5.4)', () => {
  it("refuses another user's folder as a create or move target, and leaves their tree alone", async () => {
    const { a, b } = await twoUsers();
    const theirs = await folders.create({ userId: b.id, name: 'theirs' });
    const mine = await folders.create({ userId: a.id, name: 'mine' });
    const before = await snapshot(b.id);

    await expect(
      folders.create({ userId: a.id, name: 'intruder', parentId: theirs.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(folders.patch({ userId: a.id, id: mine.id, parentId: theirs.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const after = await snapshot(b.id);
    expect(after).toEqual(before);
    expect(after.has(theirs.id)).toBe(true);
    // Nothing was created for me either, and my folder is still where it was.
    const mineAfter = await snapshot(a.id);
    expect(mineAfter).toEqual(new Map([[mine.id, null]]));
  });
});

describe('concurrent moves and the per-user advisory lock (§5.3, §7)', () => {
  it('serialises two adjacent moves started as siblings: one commits, the other conflicts', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const a = await folders.create({ userId: user.id, name: 'A' });
    const b = await folders.create({ userId: user.id, name: 'B' });

    const results = await Promise.allSettled([
      folders.patch({ userId: user.id, id: a.id, parentId: b.id }),
      folders.patch({ userId: user.id, id: b.id, parentId: a.id }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Never an unmapped `40P01`/`INTERNAL` (MVP-09 §7's last line of this criterion): the loser is told the
    // state moved, and `ConflictError` is the only way that sentence reaches the wire as a 409.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ConflictError);

    // The tree walk terminates, both folders are still reachable, and exactly one re-parent landed.
    const walked = await tree.get({ userId: user.id });
    expect(walked.folders).toHaveLength(2);
    const parents = await snapshot(user.id);
    const reparented = [...parents.entries()].filter(([, parentId]) => parentId !== null);
    expect(reparented).toHaveLength(1);
  });

  it('serialises the disjoint-pair race, which a two-row row-lock design lets through', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    // Two root folders with one child each, so that `Y ⊂ Z` and `W ⊂ X` (§5.3's example). Moving `X` under `Y`
    // gives the chain `X→Y→Z`; moving `Z` under `W` gives `Z→W→X`; together those two legal-looking moves close
    // `X→Y→Z→W→X`. The two transactions would row-lock `{X,Y}` and `{Z,W}` — disjoint sets — so nothing but the
    // per-user advisory lock orders them.
    const z = await folders.create({ userId: user.id, name: 'Z' });
    const y = await folders.create({ userId: user.id, name: 'Y', parentId: z.id });
    const x = await folders.create({ userId: user.id, name: 'X' });
    const w = await folders.create({ userId: user.id, name: 'W', parentId: x.id });
    expect([y.parentId, w.parentId]).toEqual([z.id, x.id]);

    const results = await Promise.allSettled([
      folders.patch({ userId: user.id, id: x.id, parentId: y.id }),
      folders.patch({ userId: user.id, id: z.id, parentId: w.id }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // Whichever won, no folder is its own ancestor: walk up from each one and it must terminate at the root
    // within the number of rows there are. A four-node cycle would walk forever.
    const parents = await snapshot(user.id);
    expect(parents.size).toBe(4);
    for (const id of parents.keys()) {
      const seen = new Set<string>([id]);
      let current = parents.get(id) ?? null;
      while (current !== null) {
        expect(seen.has(current), `walking up from ${id} returned to ${current}: the tree has a cycle`).toBe(
          false,
        );
        seen.add(current);
        current = parents.get(current) ?? null;
      }
      expect(seen.size).toBeLessThanOrEqual(4);
    }

    // And the tree is still walkable end to end, which the CTE's `depth < 100` guard would report as a
    // truncation if a cycle had committed.
    const walked = await tree.get({ userId: user.id });
    expect(walked.folders).toHaveLength(4);
  });
});
