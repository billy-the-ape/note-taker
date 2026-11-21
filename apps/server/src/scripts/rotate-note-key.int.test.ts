/**
 * The rotation script against a live Postgres (docs/plans/mvp/MVP-06.md §7/§8).
 *
 * This is the file the brief calls the hard part, so it is worth stating exactly what each test is guarding:
 *
 * * The script runs as a **tsx subprocess**, never as `dist/scripts/rotate-note-key.js`: the `integration` CI
 *   job runs `pnpm build:packages` only, so the compiled form does not exist there (the `.js` is asserted
 *   where a real build happens — the `build` job and PR-18's image).
 * * The row counts per `key_version` are asserted before and after every run, because "the rewrite happened"
 *   and "nothing was left on the old tag" are different claims.
 * * The concurrency test drives the **repository's own conditional update** — the statement PR-10's route will
 *   wrap — against a row the rotation is walking. Rotation never bumps `notes.version`, so a late autosave is
 *   a legitimate write and must win; if this file ever passes while a real edit could be lost, it is this
 *   file's bug.
 *
 * The env fixtures are what an operator would set (§7's sequence, with the two operator steps — editing
 * `.env` and restarting the app — already done for us): the old key in `_PREVIOUS`, the new key current, the
 * version bumped. `DOTENV_PATH` points at a file that does not exist, which `loadDevEnvFile()` documents as a
 * no-op, so a developer's local `.env` cannot leak into a subprocess.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { openNoteContent, sealNoteContent } from '../crypto/envelope.js';
import { buildKeyring, type Keyring } from '../crypto/keys.js';
import { createDb, type Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { noteById, writeNoteContent } from '../db/repositories/notes.repo.js';
import { type Note, notes } from '../db/schema.js';
import { databaseUrl } from '../env.js';
import { createOwner } from '../test/fixtures.js';
import { resetDb, testDb } from '../test/helpers/db.js';
import {
  emptySummary,
  parseRotateArgs,
  type RotatableRow,
  type RotateSummary,
  resealAndWrite,
  rowsPerKeyVersion,
} from './rotate-note-key.js';

/** Relative to `apps/server`, which is where `pnpm exec tsx` is asked to look for its local binary. */
const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join('src', 'scripts', 'rotate-note-key.ts');

const logger = pino({ level: 'silent' });

function keyBase64(seed: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index + seed) % 251)).toString('base64');
}

const KEY_1_B64 = keyBase64(11);
const KEY_2_B64 = keyBase64(212);

/** The env of the app *before* the rotation: one key, version 1 (the default). */
const envBefore: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl(),
  NOTE_ENCRYPTION_KEY: KEY_1_B64,
  // `info`, because half of these assertions read the operator's own log lines — and pino drops them below
  // that level. `error` here would make the suite assert on an empty stdout.
  LOG_LEVEL: 'info',
  DOTENV_PATH: path.join(SERVER_ROOT, 'no-such-env-file-for-tests'),
};

/** …and after: the new key is current, the old one is decrypt-only, and the version moved by hand. */
const envAfter: Record<string, string> = {
  ...envBefore,
  NOTE_ENCRYPTION_KEY: KEY_2_B64,
  NOTE_ENCRYPTION_KEY_VERSION: '2',
  NOTE_ENCRYPTION_KEY_PREVIOUS: JSON.stringify({ 1: KEY_1_B64 }),
};

/** …and after the operator emptied `_PREVIOUS` too early, which is the lossy case §4 warns about. */
const envAfterButForgetful: Record<string, string> = {
  ...envAfter,
  NOTE_ENCRYPTION_KEY_PREVIOUS: '',
};

const keyring1 = buildKeyring({ source: envBefore, logger });
const keyring2 = buildKeyring({ source: envAfter, logger });

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The operator's command: `pnpm exec tsx src/scripts/rotate-note-key.ts [flags]`. */
function runRotate(source: Record<string, string>, args: readonly string[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', SCRIPT, ...args], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...source },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The JSON lines pino wrote, decoded. Anything unparsable is a bug this suite would rather see than hide. */
function logLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A note whose body is a real envelope under `keyring`, written the way a fresh row would be: `notes.version`
 * 1, `key_version` the keyring's, and the AAD the row's own id — which is why the id is generated first here
 * rather than by the repository.
 */
async function seedNote(db: Db, userId: string, name: string, text: string, keyring: Keyring): Promise<Note> {
  const id = newId();
  const inserted = await db
    .insert(notes)
    .values({
      id,
      userId,
      name,
      ...sealNoteContent(text, id, keyring),
      contentUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error(`seedNote(${name}) inserted no row`);
  return row;
}

/** The stored row, for the assertions that care about bytes rather than plaintext. */
function stored(userId: string, id: string): Promise<Note | undefined> {
  return noteById(testDb(), { userId, id });
}

function summarise(counts: Map<number, number>): Record<number, number> {
  return Object.fromEntries(counts);
}

describe('rotate-note-key', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('refuses a nonsense --batch instead of rewriting rows on a typo', async () => {
    const run = await runRotate(envAfter, ['--batch=0']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--batch must be a whole number');
    expect(run.stderr).toContain('--verify');
    expect(parseRotateArgs(['--dry-run', '--verify', '--batch=25'])).toEqual({
      options: { batch: 25, dryRun: true, verify: true },
    });
    expect(() => parseRotateArgs(['--frobnicate'])).toThrow('unknown argument');
    expect(parseRotateArgs(['--help'])).toBe('help');
  }, 60_000);

  it('--verify reports what is left and exits 1 until nothing is', async () => {
    const owner = await createOwner(testDb());
    for (const name of ['a', 'b', 'c']) await seedNote(testDb(), owner.id, name, `body ${name}`, keyring1);

    const before = await runRotate(envAfter, ['--verify']);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain('key_version 1: 3');
    // `--verify` is read-only: the rows are untouched, so an operator can run it at any point in the runbook.
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 1: 3 });

    const rotated = await runRotate(envAfter);
    expect(rotated.code).toBe(0);

    const after = await runRotate(envAfter, ['--verify']);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain('every note is sealed with key_version 2');
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 2: 3 });
  }, 60_000);

  it('rewrites every row onto the current version, and again does nothing (idempotent)', async () => {
    const owner = await createOwner(testDb());
    const texts = ['first body', '日本語 body', '', 'a'.repeat(20_000)];
    const seeded: Note[] = [];
    for (const [index, text] of texts.entries()) {
      seeded.push(await seedNote(testDb(), owner.id, `note-${index}`, text, keyring1));
    }
    const versions = new Map(seeded.map((note) => [note.id, note.version]));
    const contentUpdated = new Map(seeded.map((note) => [note.id, note.contentUpdatedAt.getTime()]));

    const run = await runRotate(envAfter, ['--batch=2']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('note-key rotation finished');

    // None keeps the old tag: the only version left in the table is the current one.
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 2: texts.length });

    for (const [index, note] of seeded.entries()) {
      const text = texts[index] as string;
      const row = await stored(owner.id, note.id);
      expect(row, `note ${note.name} disappeared`).toBeDefined();
      if (!row) continue;
      // The plaintext survived, the tag moved, and the statistics are still about the plaintext.
      expect(openNoteContent(row, keyring2)).toBe(text);
      expect(row.keyVersion).toBe(2);
      expect(row.contentBytes).toBe(Buffer.byteLength(text, 'utf8'));
      // Rotation is not a content edit: `version` is untouched (an open tab must not 409), and
      // `content_updated_at` is too, so the "recent notes" order does not shuffle.
      expect(row.version).toBe(versions.get(note.id));
      expect(row.contentUpdatedAt.getTime()).toBe(contentUpdated.get(note.id));
    }

    // A second run is the interrupted-run case: nothing matches, nothing is written.
    const second = await runRotate(envAfter);
    expect(second.code).toBe(0);
    const finished = logLines(second.stdout).find((line) => line.msg === 'note-key rotation finished');
    expect(finished).toBeDefined();
    expect(finished?.resealed).toBe(0);
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 2: texts.length });
  }, 60_000);

  it('--dry-run reports what it would rewrite and changes no bytes', async () => {
    const owner = await createOwner(testDb());
    const note = await seedNote(testDb(), owner.id, 'dry', 'do not touch me', keyring1);
    const before = (await stored(owner.id, note.id))!;

    const run = await runRotate(envAfter, ['--dry-run']);
    // Exit 1 on purpose: the run found work, and 0 would mean "nothing left to rotate".
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('dry run');

    const after = (await stored(owner.id, note.id))!;
    expect(after.contentCipher).toEqual(before.contentCipher);
    expect(after.contentIv).toEqual(before.contentIv);
    expect(after.keyVersion).toBe(1);
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 1: 1 });
  }, 60_000);

  it('leaves an unreadable note behind, keeps its neighbours alone, and exits 1', async () => {
    const owner = await createOwner(testDb());
    // The operator bumped the version and dropped `_PREVIOUS` (§8's lossy case, at the script's level). Every
    // row still tagged 1 is unreadable to this process — which is the point of the caveat, and the reason the
    // rotation must report and continue rather than abort: one bad row cannot be allowed to stop a live
    // database mid-rewrite. The rows already on version 2 are not selected at all.
    const doomedOne = await seedNote(testDb(), owner.id, 'doomed-1', 'written under version 1', keyring1);
    const doomedTwo = await seedNote(testDb(), owner.id, 'doomed-2', 'also version 1', keyring1);
    const current = await seedNote(testDb(), owner.id, 'current', 'written under version 2', keyring2);

    const run = await runRotate(envAfterButForgetful);
    expect(run.code).toBe(1);

    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 1: 2, 2: 1 });
    const untouched = await stored(owner.id, current.id);
    expect(openNoteContent(untouched!, keyring2)).toBe('written under version 2');

    const finished = logLines(run.stdout).find((line) => line.msg === 'note-key rotation finished');
    expect(finished?.failed).toEqual([doomedOne.id, doomedTwo.id].sort());
    expect(finished?.resealed).toBe(0);
    expect(run.stdout).toContain('could not re-seal this note');

    // The rows are not corrupted, only unreadable to *this* process: the same env with `_PREVIOUS` back reads
    // them fine, which is what makes the operator's mistake recoverable up until the point the old key is gone.
    const stillReadable = await stored(owner.id, doomedOne.id);
    expect(openNoteContent(stillReadable!, keyring1)).toBe('written under version 1');
  }, 60_000);

  it('reports a database ahead of its own configuration instead of rewriting it', async () => {
    const owner = await createOwner(testDb());
    await seedNote(testDb(), owner.id, 'future', 'written under version 2', keyring2);

    // Pointing the *old* env at a rotated database is the failure this reports rather than accepting: with
    // `key_version < current` it would silently match nothing and claim success.
    const run = await runRotate(envBefore, ['--verify']);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('above NOTE_ENCRYPTION_KEY_VERSION');
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 2: 1 });
  }, 60_000);

  it('never writes a buffered ciphertext over a row that changed underneath it', async () => {
    // The §7 re-read, driven directly so it does not depend on which of two waiting transactions Postgres
    // wakes first: `stale` is the batch row the script would have buffered, and the autosave lands after it
    // was read. A script that re-wrote `stale` here would destroy the autosave; this one re-reads and skips.
    const owner = await createOwner(testDb());
    const note = await seedNote(testDb(), owner.id, 'buffered', 'the stale body', keyring1);
    const stale: RotatableRow = {
      id: note.id,
      version: note.version,
      keyVersion: note.keyVersion,
      contentCipher: note.contentCipher,
      contentIv: note.contentIv,
    };

    const autosaved = await writeNoteContent(testDb(), {
      userId: owner.id,
      noteId: note.id,
      baseVersion: note.version,
      content: sealNoteContent('the autosave body', note.id, keyring2),
    });
    expect(autosaved).toBeDefined();

    const summary: RotateSummary = emptySummary();
    const wrote = await resealAndWrite(testDb(), stale, keyring2, summary, logger);

    expect(wrote).toBe(false);
    expect(summary).toEqual({ resealed: 0, reread: 0, skipped: 1, failed: [] });
    const row = await stored(owner.id, note.id);
    expect(openNoteContent(row!, keyring2)).toBe('the autosave body');
    expect(row!.version).toBe(note.version + 1);
    expect(row!.keyVersion).toBe(2);
  }, 60_000);

  it('loses nothing when an autosave lands on a row the rotation is walking', async () => {
    const owner = await createOwner(testDb());
    const target = await seedNote(testDb(), owner.id, 'autosave-target', 'written before', keyring1);
    // More than one batch, so the script is genuinely mid-walk rather than done before anyone could race.
    for (const index of [1, 2, 3, 4]) {
      await seedNote(testDb(), owner.id, `filler-${index}`, `filler ${index}`, keyring1);
    }

    const locker = createDb({ max: 1 });
    const writer = createDb({ max: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let running: Promise<RunResult> | undefined;
    try {
      // One transaction holds a row lock on the target so the script's `select … for update` has to wait for
      // it. That queue is the live-app condition §7 describes: autosave is writing while the rewrite runs.
      const holding = locker.db.transaction(async (tx) => {
        await tx.execute(sql`select id from notes where id = ${target.id} for update`);
        await gate;
      });

      running = runRotate(envAfter, ['--batch=2']);
      await sleep(750);

      // The second writer is PR-10's route one layer down: the repository's conditional update, from its own
      // pool, sealed with the key this process considers current.
      const autosaving = writeNoteContent(writer.db, {
        userId: owner.id,
        noteId: target.id,
        baseVersion: target.version,
        content: sealNoteContent('autosaved during the rotation', target.id, keyring2),
      });

      release();
      const [run, autosavedRow] = await Promise.all([running, autosaving, holding]);
      expect(autosavedRow, 'the autosave was rejected').toBeDefined();
      expect(run.code).toBe(0);
    } finally {
      release();
      await Promise.all([locker.close(), writer.close()]);
    }

    const row = await stored(owner.id, target.id);
    // The writer wins — the script's stale buffer never lands — and it lands at the current key version,
    // having incremented `notes.version` exactly once.
    expect(openNoteContent(row!, keyring2)).toBe('autosaved during the rotation');
    expect(row!.keyVersion).toBe(2);
    expect(row!.version).toBe(target.version + 1);

    // And the rotation still finished its job: one version in the table, and `--verify` agrees.
    expect(summarise(await rowsPerKeyVersion(testDb()))).toEqual({ 2: 5 });
    const verified = await runRotate(envAfter, ['--verify']);
    expect(verified.code).toBe(0);
  }, 60_000);
});
