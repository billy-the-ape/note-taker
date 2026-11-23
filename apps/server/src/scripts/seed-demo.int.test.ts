/**
 * `scripts/seed-demo.ts`, run twice against a real Postgres (docs/plans/mvp/MVP-09.md §5.8, §7).
 *
 * A seed is judged by what the *second* run does. The first run only has to be interesting — one demo account, a
 * tree three levels deep, a note at every level, one body whose byte count differs from its character count — and
 * anybody can write that. The properties that are worth a database are that a re-run finds its own rows by
 * `(user, parent, name)` and inserts nothing, reports the same counts, and leaves alone whatever the demo user has
 * since edited or added. "Truncate and re-seed" satisfies the first sentence and fails all three, and only a test
 * that runs the seed twice can tell the difference.
 *
 * The second thing asserted here is that the seed wrote **readable** rows: every body is sealed through
 * {@link getKeyring}, the same memoized ring `buildApp()` installs, and is then opened again through the note
 * service. That is the only way to catch a seed that sealed against an id it had not inserted yet, or against a key
 * it generated for itself.
 *
 * The production guard is checked here rather than in a unit file only because it is a statement about this
 * program's entry point: `main()` must refuse *before* it opens a pool, and the way to show that is to call
 * `main()` in `production` and watch it exit `2` without a connection.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArgon2Hasher } from '../auth/passwords.js';
import { getKeyring } from '../crypto/keys.js';
import { createFolder } from '../db/repositories/folders.repo.js';
import { userByUsername } from '../db/repositories/users.repo.js';
import { createNoteService } from '../services/note.service.js';
import { createTreeService } from '../services/tree.service.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import {
  DEMO_PASSWORD,
  DEMO_ROOT_NOTES,
  DEMO_TREE,
  DEMO_USERNAME,
  main,
  type SeedSummary,
  seedDemo,
  seedRefusal,
} from './seed-demo.js';

const db = testDb();
const keyring = getKeyring();
const passwords = createArgon2Hasher();
const notes = createNoteService({ db, keyring });
const tree = createTreeService({ db });

/**
 * The shape of {@link DEMO_TREE}: `projects/2026/archive` plus `reading` is four folders, and four folder notes
 * plus two root notes is six. Stated as numbers here, because the summary's job is to report them.
 */
const EXPECTED_FOLDERS = 4;
const EXPECTED_NOTES = DEMO_ROOT_NOTES.length + 4;

beforeEach(async () => {
  await resetDb();
});

/** The demo user, which every assertion below needs and none of them creates. */
async function demoUserId(): Promise<string> {
  const user = await userByUsername(db, DEMO_USERNAME);
  if (user === undefined) throw new Error(`the seed did not create ${DEMO_USERNAME}`);
  return user.id;
}

/** The name of a folder by id, for the parent-chain assertions below. */
function nameOf(folders: readonly { id: string; name: string }[], id: string): string {
  const found = folders.find((folder) => folder.id === id);
  if (found === undefined) throw new Error(`no folder ${id} in the tree the seed wrote`);
  return found.name;
}

/** `name → id` for the demo user's folders and notes, so two runs can be compared row for row. */
async function names(): Promise<{ folders: Map<string, string>; notes: Map<string, string> }> {
  const listed = await tree.get({ userId: await demoUserId() });
  return {
    folders: new Map(listed.folders.map((folder) => [folder.name, folder.id])),
    notes: new Map(listed.notes.map((note) => [note.name, note.id])),
  };
}

async function countRows(table: 'folders' | 'notes'): Promise<number> {
  const rows = await catalogRows(sql.raw(`select count(*)::int as n from ${table}`));
  return Number(rows[0]?.n ?? -1);
}

/** The digest of one note's stored body: proof that a re-run did not re-seal it. */
async function cipherDigest(noteId: string): Promise<string> {
  const rows = await catalogRows(
    sql`select md5(content_cipher::text) as digest from notes where id = ${noteId}`,
  );
  return String(rows[0]?.digest);
}

describe('the seed writes the demo tree (§5.8)', () => {
  it('creates one account, four folders and six notes, in the shape the brief asks for', async () => {
    const summary = await seedDemo(db, { passwords, keyring });
    expect(summary).toEqual({
      user: 'created',
      foldersCreated: EXPECTED_FOLDERS,
      notesCreated: EXPECTED_NOTES,
      foldersKept: 0,
      notesKept: 0,
    });

    const userId = await demoUserId();
    const listed = await tree.get({ userId });
    expect(listed.folders).toHaveLength(EXPECTED_FOLDERS);
    expect(listed.notes).toHaveLength(EXPECTED_NOTES);
    expect(new Map(listed.folders.map((folder) => [folder.name, folder.id])).size).toBe(EXPECTED_FOLDERS);

    // `projects/2026/archive`: three levels, which is the depth one branch has to reach, and `reading` beside it.
    const parents = new Map(
      listed.folders.map((folder) => [
        folder.name,
        folder.parentId === null ? null : nameOf(listed.folders, folder.parentId),
      ]),
    );
    expect(parents.get('projects')).toBeNull();
    expect(parents.get('2026')).toBe('projects');
    expect(parents.get('archive')).toBe('2026');
    expect(parents.get('reading')).toBeNull();

    // A note at the root and a note at the bottom of the deep branch, i.e. a note at every level (§5.8).
    const noteParents = new Map(
      listed.notes.map((note) => [
        note.name,
        note.folderId === null ? null : nameOf(listed.folders, note.folderId),
      ]),
    );
    expect(noteParents.get('welcome')).toBeNull();
    expect(noteParents.get('scratch')).toBeNull();
    expect(noteParents.get('roadmap')).toBe('projects');
    expect(noteParents.get('q4-goals')).toBe('2026');
    expect(noteParents.get('meeting-notes')).toBe('archive');
    expect(noteParents.get('books')).toBe('reading');

    // The account is a `member`, never the owner: `users_one_owner_uidx` allows exactly one owner, and it is
    // `/api/auth/setup` that claims it. A seed that took the slot would break the first-run wizard.
    const roles = await catalogRows(sql`select role from users where id = ${userId}`);
    expect(roles[0]?.role).toBe('member');
    // …and it got its settings row from the same statement that created it (§5.7).
    const settings = await catalogRows(sql`select autosave, theme from settings where user_id = ${userId}`);
    expect(settings).toHaveLength(1);
    expect(settings[0]?.autosave).toBe(true);
  });

  it('seals real bodies, including the one whose bytes outnumber its characters', async () => {
    await seedDemo(db, { passwords, keyring });
    const userId = await demoUserId();
    const { notes: byName } = await names();

    const meetingNotes = byName.get('meeting-notes');
    if (meetingNotes === undefined) throw new Error('the seed wrote no meeting-notes');
    const body = await notes.read({ userId, id: meetingNotes });
    expect(body.content).toContain('Émile');
    expect(body.content).toContain('const note = await api.createNote({ content });');
    // Plan §10: `content_bytes` counts UTF-8 bytes, and this is the body where that choice is visible.
    const bytes = new TextEncoder().encode(body.content).byteLength;
    expect(body.contentBytes).toBe(bytes);
    expect(bytes).toBeGreaterThan([...body.content].length);

    // An empty body is a sealed empty string, not an absent envelope (§5.6).
    const scratch = byName.get('scratch');
    if (scratch === undefined) throw new Error('the seed wrote no scratch note');
    const empty = await notes.read({ userId, id: scratch });
    expect([empty.content, empty.contentBytes, empty.wordCount]).toEqual(['', 0, 0]);
    const columns = await catalogRows(
      sql`select octet_length(content_cipher) as cipher, octet_length(content_iv) as iv, content_bytes
            from notes where id = ${scratch}`,
    );
    expect(Number(columns[0]?.iv)).toBe(12);
    expect(Number(columns[0]?.cipher)).toBeGreaterThanOrEqual(16);
    expect(columns[0]?.content_bytes).toBe(0);
  });

  it('opens every seeded body with the process keyring, so the API can read what the seed wrote', async () => {
    await seedDemo(db, { passwords, keyring });
    const userId = await demoUserId();
    const { notes: byName } = await names();
    expect(byName.size).toBe(EXPECTED_NOTES);

    for (const [name, id] of byName) {
      // A body sealed against the wrong id or the wrong key would throw `EnvelopeError` here, not in PR-12's UI.
      await expect(notes.read({ userId, id })).resolves.toMatchObject({ name });
    }
  });
});

describe('the seed run twice (§5.8, §7)', () => {
  it('inserts nothing the second time and reports the same counts', async () => {
    const first: SeedSummary = await seedDemo(db, { passwords, keyring });
    const afterFirst = await names();
    const firstCounts = { folders: await countRows('folders'), notes: await countRows('notes') };
    expect(first.user).toBe('created');

    const second = await seedDemo(db, { passwords, keyring });
    expect(second.user).toBe('existing');
    expect([second.foldersCreated, second.notesCreated]).toEqual([0, 0]);
    // Everything it was going to make, it found by name: the same four folders and six notes.
    expect([second.foldersKept, second.notesKept]).toEqual([EXPECTED_FOLDERS, EXPECTED_NOTES]);

    expect({ folders: await countRows('folders'), notes: await countRows('notes') }).toEqual(firstCounts);
    // Not merely the same *number* of rows — the same rows, under the same ids.
    expect(await names()).toEqual(afterFirst);

    // And one account, because a second seed that tried to insert a second `demo` would have hit the unique index
    // instead of reporting `existing`.
    const accounts = await catalogRows(
      sql`select count(*)::int as n from users where username = ${DEMO_USERNAME}`,
    );
    expect(accounts[0]?.n).toBe(1);
  });

  it('leaves a demo user who has been editing alone', async () => {
    await seedDemo(db, { passwords, keyring });
    const userId = await demoUserId();
    const roadmap = (await names()).notes.get('roadmap');
    if (roadmap === undefined) throw new Error('the seed wrote no roadmap');

    // Two things a real person does: rewrite a seeded body, and add a folder the seed has never heard of.
    const edited = await catalogRows(
      sql`update notes set content_cipher = sha256(content_cipher || 'edited')
           where id = ${roadmap} returning md5(content_cipher::text) as digest`,
    );
    const digestAfterEdit = String(edited[0]?.digest);
    const mine = await createFolder(db, { userId, parentId: null, name: 'my own work' });

    const before = await names();
    const summary = await seedDemo(db, { passwords, keyring });

    // The seed's own tree was all there already, so it created nothing; my folder is not in its tree, so it neither
    // matched nor deleted it. And the body I edited is byte-for-byte the body I left.
    expect([summary.foldersCreated, summary.notesCreated]).toEqual([0, 0]);
    expect(summary.foldersKept).toBe(EXPECTED_FOLDERS);
    // Nothing of mine disappeared, and nothing of theirs was duplicated alongside it. (Vitest compares `Map`s by
    // entry, which is what a name→id snapshot needs.)
    expect(before).toEqual(await names());
    expect(await countRows('folders')).toBe(EXPECTED_FOLDERS + 1);
    expect((await names()).folders.get('my own work')).toBe(mine.id);
    expect(await cipherDigest(roadmap)).toBe(digestAfterEdit);
  });
});

describe('the production guard (§5.8)', () => {
  it('names the refusal for production only, and exits 2 from the entry point', async () => {
    expect(seedRefusal('production')).toContain('production');
    expect(seedRefusal('development')).toBeUndefined();
    expect(seedRefusal('test')).toBeUndefined();
    expect(seedRefusal(undefined)).toBeUndefined();

    // The entry point in the mode it must refuse. It checks the mode before it builds a keyring or opens a pool, so
    // this neither needs nor gets a connection — the half of the criterion a database test cannot show.
    const previousMode = process.env.NODE_ENV;
    const write = process.stderr.write;
    process.stderr.write = () => true;
    try {
      process.env.NODE_ENV = 'production';
      expect(await main([])).toBe(2);
    } finally {
      process.stderr.write = write;
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
    }

    // The attempt that refused wrote nothing.
    expect(await countRows('folders')).toBe(0);
  });

  it('stores a hash of the password it prints, and never the password itself', async () => {
    expect(DEMO_TREE.length).toBeGreaterThan(1);
    const summary = await seedDemo(db, { passwords, keyring });
    expect(summary.user).toBe('created');

    // The credential the runbook prints, verified against the hash the seed actually stored.
    const stored = await catalogRows(sql`select password_hash from users where username = ${DEMO_USERNAME}`);
    const hash = String(stored[0]?.password_hash);
    expect(hash).not.toContain(DEMO_PASSWORD);
    expect(await passwords.verify(hash, DEMO_PASSWORD)).toBe(true);
  });
});
