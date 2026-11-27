/**
 * `services/tree.service.ts` over a real Postgres (docs/plans/mvp/MVP-09.md §5.1, §7).
 *
 * `GET /api/tree` promises three things, and each has a failure mode this file tries to cause:
 *
 * * **Metadata only.** A note body must never cross the wire in this payload — so the assertion is about the
 *   *keys* of every node in both lists, not about a size. The notes in this file are created through the note
 *   service, i.e. they are real sealed rows, so the tree has real bodies available and still reports none.
 * * **Completeness at the cap.** The CTE's `depth < 100` is a runaway belt against a corrupted `parent_id`, not a
 *   truncation rule, and the only way to tell the two apart is to build the deepest legal tree there is — 100
 *   folders, depths 0…99 — and count what comes back.
 * * **One deterministic order.** Both lists sort by name in `collate "C"`, i.e. by bytes: `B` before `a`. A test
 *   that sorted case-insensitively would pass on a locale-ordered index and break the moment someone "fixed" the
 *   collation, which is exactly the kind of drift §4's collation clause is there to prevent.
 */
import { FOLDER_MAX_DEPTH, folderNodeSchema, noteNodeSchema } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getKeyring } from '../crypto/keys.js';
import { createUser } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { createFolderService } from './folder.service.js';
import { createNoteService } from './note.service.js';
import { createTreeService } from './tree.service.js';

const db = testDb();
const folders = createFolderService({ db });
const notes = createNoteService({ db, keyring: getKeyring() });
const tree = createTreeService({ db });

const CAP = FOLDER_MAX_DEPTH + 1;

beforeEach(async () => {
  await resetDb();
});

describe('GET /api/tree (§9.2 #12)', () => {
  it('returns two flat lists of nodes, and no content anywhere in the payload', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    const top = await folders.create({ userId: user.id, name: 'top' });
    const nested = await folders.create({ userId: user.id, name: 'nested', parentId: top.id });
    await notes.create({ userId: user.id, name: 'in-root', content: 'a body that must not travel' });
    await notes.create({ userId: user.id, name: 'in-nested', folderId: nested.id, content: 'another body' });

    const response = await tree.get({ userId: user.id });

    expect(response.folders).toHaveLength(2);
    expect(response.notes).toHaveLength(2);
    // Flat: the contract's node has no `children`, and re-nesting is PR-12's selectors.
    for (const folder of response.folders) {
      expect(folderNodeSchema.parse(folder)).toEqual(folder);
      expect(Object.keys(folder)).not.toContain('children');
    }
    for (const note of response.notes) {
      expect(noteNodeSchema.parse(note)).toEqual(note);
    }
    // §7's last criterion, read off the keys rather than off a length.
    const wire = JSON.stringify(response);
    expect(wire).not.toContain('must not travel');
    expect(wire).not.toContain('another body');
    expect(wire).not.toContain('content"');
    expect(response.notes[0]).not.toHaveProperty('content');
  });

  it('orders both lists by name in byte collation, folders then notes', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    for (const name of ['banana', 'Apple', 'cherry', '_underscore']) {
      await folders.create({ userId: user.id, name });
    }
    for (const name of ['zebra-note', 'Beta-note', 'Aa-note']) {
      await notes.create({ userId: user.id, name });
    }

    const response = await tree.get({ userId: user.id });
    // `collate "C"` is byte order: `A` (0x41) < `_` (0x5F) < `b` (0x62) < `c` (0x63). A locale-aware collation
    // would interleave the case-folded words and put `_` last, which is precisely the drift this pins.
    expect(response.folders.map((folder) => folder.name)).toEqual([
      'Apple',
      '_underscore',
      'banana',
      'cherry',
    ]);
    expect(response.notes.map((note) => note.name)).toEqual(['Aa-note', 'Beta-note', 'zebra-note']);
  });

  it('renders a 100-level chain complete, with a note at the bottom, nothing truncated', async () => {
    const user = await createUser(db, { username: 'a', role: 'member' });
    let parentId: string | null = null;
    for (let level = 0; level < CAP; level += 1) {
      const folder = await folders.create({
        userId: user.id,
        name: `l${String(level).padStart(3, '0')}`,
        parentId,
      });
      parentId = folder.id;
    }
    if (parentId === null) throw new Error('the chain did not reach the cap');
    const deep = await notes.create({
      userId: user.id,
      name: 'bottom',
      folderId: parentId,
      content: 'deep body',
    });

    const response = await tree.get({ userId: user.id });
    // The CTE walks to `depth < 100`, so depth 99 is the last legal row and all 100 must be present (§5.1).
    expect(response.folders).toHaveLength(CAP);
    expect(response.notes).toHaveLength(1);
    expect(response.notes[0]?.id).toBe(deep.id);
    expect(response.notes[0]?.folderId).toBe(parentId);
    // The chain is connected end to end: every folder's parent is the one before it, and the root has none.
    const byName = new Map(response.folders.map((folder) => [folder.name, folder]));
    const ordered = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    expect(ordered[0]?.parentId).toBeNull();
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]?.parentId).toBe(ordered[index - 1]?.id);
    }
  });

  it("never shows another user's rows", async () => {
    const a = await createUser(db, { username: 'a', role: 'member' });
    const b = await createUser(db, { username: 'b', role: 'member' });
    await folders.create({ userId: a.id, name: 'mine' });
    await notes.create({ userId: a.id, name: 'my-note' });
    await folders.create({ userId: b.id, name: 'theirs' });
    await notes.create({ userId: b.id, name: 'their-note' });

    const response = await tree.get({ userId: a.id });
    expect(response.folders.map((folder) => folder.name)).toEqual(['mine']);
    expect(response.notes.map((note) => note.name)).toEqual(['my-note']);

    const rows = await catalogRows(sql`select count(*)::int as n from folders where user_id = ${b.id}`);
    expect(rows[0]?.n).toBe(1);
  });
});
