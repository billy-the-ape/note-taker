/**
 * The two properties of `PUT /api/notes/:id/content` that cannot be measured without a second connection and a
 * `pg_stat_activity` probe (docs/plans/mvp/MVP-10.md §6, criteria 6 and 7).
 *
 * Both are about what the database sees, not about what the client is told, which is why they are separate from
 * `notes.routes.int.test.ts`:
 *
 * * **A request killed mid-flight leaves no partial write** (criterion 6, plan Appendix A.2). The write is one
 *   statement, so the only states that exist are before it and after it. This proves it by *cancelling a real
 *   request* rather than by pointing at the SQL: a transaction parks on the row, the `PUT` queues behind it,
 *   `pg_stat_activity` says the queue really existed, and `pg_cancel_backend` kills the statement while it waits.
 *   The row must then hold the ciphertext, the IV, the key version, the byte count, the word count and the version
 *   it had before, all of them — one statement that was rolled back leaves no mixture, and a write split across two
 *   statements is exactly the mixture.
 * * **PR-06's rotation guarantee, one layer up** (criterion 7). `rotate-note-key.int.test.ts` races the rotation
 *   against the repository's conditional update; this races it against the HTTP endpoint an editor actually calls,
 *   with the app restarted on the new key the way the runbook restarts it. The note has to end with the **client's**
 *   body at the current `key_version`, `version` bumped exactly once, and `--verify` still exiting 0 — and it has
 *   to do that whichever of the two writers Postgres wakes first, so nothing below depends on winning the race, only
 *   on both outcomes being the same.
 *
 * Every wait here is a poll for the state the test needs, never a `sleep`: a race that a timing change can quietly
 * stop exercising is how the bug PR-06's short-batch test exists to catch got shipped.
 */
import { noteWithContentSchema, ROUTES } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { openNoteContent } from '../crypto/envelope.js';
import { getKeyring } from '../crypto/keys.js';
import { createDb } from '../db/client.js';
import { noteById } from '../db/repositories/notes.repo.js';
import { databaseUrl } from '../env.js';
import { rowsPerKeyVersion } from '../scripts/rotate-note-key.js';
import { withApp } from '../test/helpers/app.js';
import { jarHeaders } from '../test/helpers/cookies.js';
import { resetDb, testDb } from '../test/helpers/db.js';
import {
  envAfter,
  keyringAfter,
  keyringBefore,
  runRotate,
  waitForBlockedRotation,
} from '../test/helpers/rotation.js';
import { bootstrapOwner, envelopeOf, whoAmI } from '../test/helpers/session.js';

const db = testDb();

beforeEach(async () => {
  await resetDb();
});

/** The app's own pool, so a test that breaks a connection breaks one nobody else is holding. */
function appPool() {
  return createDb({ url: databaseUrl(), max: 4 });
}

/** The stored row, read through the repository that has no idea either test exists. */
async function stored(userId: string, id: string) {
  const row = await noteById(db, { userId, id });
  if (row === undefined) throw new Error(`no note row for ${id}`);
  return row;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether some session is right now holding a row lock and doing nothing with it — i.e. this file's own locker
 * transaction has reached the statement that parks it.
 *
 * A test that fires its request the moment it *starts* a transaction can lose the race in the wrong direction and
 * measure nothing: here the write would simply commit, and the poll below would report "never queued" five seconds
 * later. Waiting for the lock to exist is what makes the queue observable at all.
 */
async function rowLockIsHeld(): Promise<boolean> {
  const held = (await db.execute(
    sql`select 1
          from pg_stat_activity
         where state = 'idle in transaction' and query ilike '%for update%'
         limit 1`,
  )) as unknown as unknown[];
  return held.length > 0;
}

/** Polls {@link rowLockIsHeld} so the request is only sent once there is something to queue behind. */
async function waitForRowLock(tries = 100): Promise<boolean> {
  for (let tick = 0; tick < tries; tick += 1) {
    if (await rowLockIsHeld()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * The pid of a session whose `UPDATE notes …` is right now waiting for a row lock, if there is one.
 *
 * `wait_event_type = 'Lock'` plus the statement's own text is how this distinguishes "the request is in flight and
 * blocked" from "the request has not started yet". The locker itself does not match: while it holds the row it is
 * `idle in transaction`, not active, and it is not waiting for anything.
 */
async function blockedUpdaterPid(): Promise<string | undefined> {
  const found = (await db.execute(
    sql`select pid::text as pid
          from pg_stat_activity
         where state = 'active' and wait_event_type = 'Lock'
           and query ilike 'update "notes"%'
         order by pid
         limit 1`,
  )) as unknown as { pid: string }[];
  return found[0]?.pid;
}

/** Polls {@link blockedUpdaterPid} so the abort lands while the statement is genuinely queued. */
async function waitForBlockedUpdater(tries = 100): Promise<string | undefined> {
  for (let tick = 0; tick < tries; tick += 1) {
    const pid = await blockedUpdaterPid();
    if (pid !== undefined) return pid;
    await sleep(50);
  }
  return undefined;
}

/** Cancels one session's current statement, leaving its connection (and this suite's pool) alone. */
async function cancelStatement(pid: string): Promise<boolean> {
  const done = (await db.execute(
    sql`select pg_cancel_backend(${Number(pid)})::text as cancelled`,
  )) as unknown as { cancelled: string }[];
  return done[0]?.cancelled === 'true';
}

describe('a content write killed mid-flight (PR-10 §6)', () => {
  it('leaves the note exactly as it was, with no mixture of the two bodies', async () => {
    const pool = appPool();
    const locker = createDb({ max: 1 });
    let release: () => void = () => {};
    try {
      await withApp(
        async (app: FastifyInstance) => {
          const owner = await bootstrapOwner(app);
          const ownerId = await whoAmI(app, owner);
          const created = await app.inject({
            method: 'POST',
            url: ROUTES.notes,
            headers: jarHeaders(owner),
            payload: { name: 'cancelled', content: 'the body that survives' },
          });
          const note = noteWithContentSchema.parse(created.json());
          const before = await stored(ownerId, note.id);
          expect([before.version, before.wordCount]).toEqual([1, 4]);

          // One row lock is the whole simulation: everything behind it is a request waiting to be either applied or
          // abandoned, which is the one moment the acceptance criterion is about.
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const holding = locker.db.transaction(async (tx) => {
            await tx.execute(sql`select id from notes where id = ${note.id} for update`);
            await gate;
          });

          // Wrapped in a function of its own so `response` is inferred rather than an implicit-any `let`, and so
          // the row lock is handed back on the way out even if an assertion in the middle of the race fails.
          const response = await (async () => {
            // The lock has to be *held* before the write is sent, not merely started: otherwise the write wins a
            // race nobody intended and the queue this test depends on never forms.
            expect(await waitForRowLock(), 'the locker never got the row lock').toBe(true);
            const inflight = app.inject({
              method: 'PUT',
              url: ROUTES.noteContent(note.id),
              headers: jarHeaders(owner),
              payload: { content: 'the body that never lands', baseVersion: 1 },
            });
            try {
              const pid = await waitForBlockedUpdater();
              // Asserted, not assumed: if the statement was never queued then nothing was cancelled mid-flight and
              // the rest of this test would be a green no-op, which is the failure mode the rotation suite names.
              expect(
                pid,
                'the write never queued behind the row lock, so nothing was aborted mid-flight',
              ).toStrictEqual(expect.any(String));
              expect(await cancelStatement(String(pid))).toBe(true);
              return await inflight;
            } finally {
              release();
              await holding;
            }
          })();

          // The database refused to finish the statement, so the request failed — and failed as a server fault,
          // which is what that is. Nothing about the note moved.
          expect(response.statusCode).toBe(500);
          expect(envelopeOf(response).code).toBe('INTERNAL');

          const after = await stored(ownerId, note.id);
          // Not only "the version did not move": every column the write owns still describes the *same* body, byte
          // for byte, including the IV — so no new envelope went in. A body re-sealed in one statement with its
          // statistics set in another would show up here as a mixture, and the single statement is what prevents it.
          expect(after.version).toBe(before.version);
          expect(after.contentCipher).toEqual(before.contentCipher);
          expect(after.contentIv).toEqual(before.contentIv);
          expect(after.keyVersion).toBe(before.keyVersion);
          expect([after.contentBytes, after.wordCount]).toEqual([before.contentBytes, before.wordCount]);
          expect(after.contentUpdatedAt.getTime()).toBe(before.contentUpdatedAt.getTime());
          expect(openNoteContent(after, getKeyring())).toBe('the body that survives');
        },
        { db: pool.db },
      );
    } finally {
      release();
      await Promise.all([pool.close(), locker.close()]);
    }
  }, 60_000);
});

describe('a content write landing during a key rotation (PR-10 §6)', () => {
  it('keeps the client body at the current key_version and bumps version exactly once', async () => {
    const pool = appPool();
    const locker = createDb({ max: 1 });
    let release: () => void = () => {};

    // The row and four fillers, all sealed with key version 1: the rotation has real work to walk, and more rows
    // than `--batch=2` means more than one batch, so "mid-rotation" is a state that exists rather than a phrase.
    const seeded = await withApp(
      async (app: FastifyInstance) => {
        const owner = await bootstrapOwner(app);
        const ownerId = await whoAmI(app, owner);
        const target = await app.inject({
          method: 'POST',
          url: ROUTES.notes,
          headers: jarHeaders(owner),
          payload: { name: 'during-rotation', content: 'written before the rotation' },
        });
        for (const index of [1, 2, 3, 4]) {
          await app.inject({
            method: 'POST',
            url: ROUTES.notes,
            headers: jarHeaders(owner),
            payload: { name: `filler-${index}`, content: `filler ${index}` },
          });
        }
        return {
          ownerId,
          jar: owner,
          note: noteWithContentSchema.parse(target.json()),
        };
      },
      { db: pool.db, keyring: keyringBefore },
    );
    expect((await stored(seeded.ownerId, seeded.note.id)).keyVersion).toBe(1);

    try {
      // The app as the operator leaves it after the runbook's second step: restarted, so it seals with key 2 and
      // still reads key 1. The jar is the same session, because the session row — unlike the keyring — survived.
      await withApp(
        async (app: FastifyInstance) => {
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const holding = locker.db.transaction(async (tx) => {
            await tx.execute(sql`select id from notes where id = ${seeded.note.id} for update`);
            await gate;
          });

          const rotating = runRotate(envAfter, ['--batch=2']);
          const parked = await waitForBlockedRotation(db);
          expect(
            parked,
            'the rotation never queued behind the row lock, so the write never landed mid-rotation',
          ).toBe(true);

          const putting = app.inject({
            method: 'PUT',
            url: ROUTES.noteContent(seeded.note.id),
            headers: jarHeaders(seeded.jar),
            payload: { content: 'saved during the rotation', baseVersion: seeded.note.version },
          });

          release();
          const [run, response] = await Promise.all([rotating, putting, holding]);
          expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
          // Whichever writer Postgres woke first, the autosave is a legitimate write against a version the rotation
          // deliberately never moved, so it is served rather than conflicted. Had the rotation gone first,
          // `baseVersion` still matches — that is what PR-06's "rotation is not a content edit" rule buys an editor
          // with an open tab, and it is the reason this request cannot be a coin flip.
          expect(response.statusCode, response.body).toBe(200);
          expect(noteWithContentSchema.parse(response.json()).version).toBe(seeded.note.version + 1);
        },
        { db: pool.db, keyring: keyringAfter },
      );
    } finally {
      release();
      await Promise.all([pool.close(), locker.close()]);
    }

    const row = await stored(seeded.ownerId, seeded.note.id);
    // The client's text, at the current key version, exactly one version past where it started: not the rotation's
    // re-sealed copy of the old body, and not two increments, which would mean the rotation counted it as an edit
    // as well as rewriting it.
    expect(openNoteContent(row, keyringAfter)).toBe('saved during the rotation');
    expect(row.keyVersion).toBe(2);
    expect(row.version).toBe(seeded.note.version + 1);
    expect([row.contentBytes, row.wordCount]).toEqual([25, 4]);

    // One key version left in the table, and the operator's own read-only check agrees: a write landing on a row
    // mid-walk never stranded anything on the retired key.
    expect(Object.fromEntries(await rowsPerKeyVersion(db))).toEqual({ 2: 5 });
    const verified = await runRotate(envAfter, ['--verify']);
    expect(verified.code, `${verified.stdout}\n${verified.stderr}`).toBe(0);
  }, 120_000);
});
