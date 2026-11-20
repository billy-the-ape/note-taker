/**
 * The recovery script, run the way an operator runs it: a real subprocess, against the test database (§6 of the
 * brief).
 *
 * The subprocess is the point, not an obstacle. `run()` is exported and takes argv and streams so that a unit
 * test could do this in-process, but the properties that matter here live in the boot: that `invokedDirectly()`
 * fires (and does not fire inside a Vitest worker, which would reset a password mid-suite), that `--help` is
 * reachable without a database, that a bad username costs an exit code rather than a stack trace, and that the
 * process actually ends — a script that resets a password and then hangs holding a pool is not much of a
 * recovery tool.
 *
 * The assertions are deliberately about what the script may **not** do, because that is the failure this file
 * exists to prevent. Every other `user_id` foreign key is `ON DELETE CASCADE` (`docs/DATA-MODEL.md`), so the
 * tempting "simplification" of recovery — delete the user, create them again — is the destruction of that
 * person's notes, followed by a `/setup` that answers `409` forever. Everything the user owns therefore has to
 * still be there afterwards.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '@note-taker/contracts';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArgon2Hasher } from '../auth/passwords.js';
import { issueSession } from '../db/repositories/sessions.repo.js';
import { databaseUrl } from '../env.js';
import { createMember, createOwner, makeNote } from '../test/fixtures.js';
import { withApp } from '../test/helpers/app.js';
import { jarAfter } from '../test/helpers/cookies.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';

const OLD_PASSWORD = 'the-password-they-forgot';
const NEW_PASSWORD = 'the-one-they-typed-into-the-script';
const SCRIPT = fileURLToPath(new URL('./reset-password.ts', import.meta.url));

/**
 * `node --import tsx <script> <username> [password]`, in apps/server so `tsx` resolves the way the package's own
 * scripts resolve it, and with the DSN the integration setup file resolved — the same pair of variables
 * `docs/DEPLOY.md` will hand an operator, only pointed at the test database.
 */
function runScript(...argv: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...argv], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl() },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `count(*)` of one table, so "nothing was destroyed" is a number rather than a vibe. */
async function count(table: string): Promise<number> {
  const rows = await catalogRows(sql`select count(*)::int as n from ${sql.raw(table)}`);
  return Number(rows[0]?.n ?? -1);
}

beforeEach(async () => {
  await resetDb();
});

describe('reset-password.ts (§6)', () => {
  it('replaces the password, signs every device out, and leaves every other row alone', async () => {
    const db = testDb();
    const hasher = createArgon2Hasher({ memoryCost: 8_192, timeCost: 1, parallelism: 1 });
    const owner = await createOwner(db, 'owner');
    const member = await createMember(db, 'member');
    const note = await makeNote(db, owner.id, { name: 'A note', text: 'still here' });
    // Three sessions through the repository, two of them the owner's: the count in the script's own line is the
    // thing under test, so the rows have to be exactly as many as they look.
    const bytes = (n: number) => new Uint8Array(32).fill(n);
    await issueSession(db, {
      tokenHash: bytes(0),
      userId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await issueSession(db, {
      tokenHash: bytes(1),
      userId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await issueSession(db, {
      tokenHash: bytes(2),
      userId: member.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.execute(
      sql`update users set password_hash = ${await hasher.hash(OLD_PASSWORD)} where id = ${owner.id}`,
    );
    const setAtBefore = await catalogRows(sql`select password_set_at from users where id = ${owner.id}`);

    const run = runScript('owner', NEW_PASSWORD);
    expect(run.stderr, run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('owner');
    // Two of this user's three sessions, and not the third person's one.
    expect(run.stdout).toMatch(/2 session\(s\) signed out/);
    expect(await count('sessions')).toBe(1);
    expect(await catalogRows(sql`select user_id from sessions where user_id = ${member.id}`)).toHaveLength(1);

    // The row was updated, not replaced: same id, same username, same created-at, notes and settings untouched.
    expect(await count('users')).toBe(2);
    expect(await count('settings')).toBe(2);
    expect(await count('notes')).toBe(1);
    expect(await catalogRows(sql`select id, username from users where id = ${owner.id}`)).toEqual([
      { id: owner.id, username: 'owner' },
    ]);
    expect(await catalogRows(sql`select name from notes where id = ${note.id}`)).toHaveLength(1);

    // `password_set_at` is the only evidence the script ever ran (`auth_attempts` deliberately holds nothing:
    // this path never verifies the old password, so a row there would be an invented fact).
    const setAtAfter = await catalogRows(sql`select password_set_at from users where id = ${owner.id}`);
    expect(Date.parse(String(setAtAfter[0]?.password_set_at))).toBeGreaterThan(
      Date.parse(String(setAtBefore[0]?.password_set_at)),
    );
    expect(await count('auth_attempts')).toBe(0);

    // …and the new password is the one that works, through the real endpoints.
    await withApp(
      async (app) => {
        const stale = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'owner', password: OLD_PASSWORD },
        });
        expect(stale.statusCode).toBe(401);

        const fresh = await app.inject({
          method: 'POST',
          url: ROUTES.auth.login,
          payload: { username: 'OWNER', password: NEW_PASSWORD },
        });
        expect(fresh.statusCode, fresh.body).toBe(200);
        expect(jarAfter(fresh).session).toBeTruthy();
      },
      { db },
    );
  });

  it('writes nothing for a username that does not exist, and says so in the exit code', async () => {
    const db = testDb();
    const owner = await createOwner(db, 'owner');
    await issueSession(db, {
      tokenHash: new Uint8Array(32).fill(3),
      userId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const hashBefore = await catalogRows(sql`select password_hash from users where id = ${owner.id}`);

    // A typo at 3 a.m. is the normal case for this script, so the interesting claim is not that it fails but that
    // failing cost nothing: the account keeps its password and its sessions.
    const run = runScript('onwer', NEW_PASSWORD);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('no account named onwer');
    // The claim is about the secret, not the word: the script's own name is `reset-password`, so a regex on
    // "password" would only ever prove that stderr is not empty. What must never appear is the value the
    // operator passed on the command line, because argv is world-readable on a shared host (`ps`).
    expect(run.stderr).not.toContain(NEW_PASSWORD);
    expect(run.stdout).not.toContain(NEW_PASSWORD);
    expect(await count('sessions')).toBe(1);
    const hashAfter = await catalogRows(sql`select password_hash from users where id = ${owner.id}`);
    expect(hashAfter).toEqual(hashBefore);

    // A password that breaks the policy is refused the same way, and by the same rules the API enforces — the
    // script cannot be a door around the password policy.
    for (const rejected of ['short', 'owner']) {
      const attempt = runScript('owner', rejected);
      expect(attempt.code, rejected).not.toBe(0);
      expect(attempt.stderr).not.toBe('');
    }
    expect(await count('sessions')).toBe(1);
  });

  it('prints its usage without a database, and tells the operator where the password goes', async () => {
    // No `DATABASE_URL`, no pool, no rows: `--help` is documentation, and a recovery tool whose help text needs a
    // working database is a recovery tool that fails at 3 a.m. for the wrong reason.
    const help = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--help'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '' },
    });
    expect(help.status).toBe(0);
    const usage = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    expect(usage).toMatch(/usage: reset-password <username> \[new-password\]/);
    // The documented rule, in the help text rather than in a comment nobody reads at 3 a.m.: on a terminal the
    // script prompts without echoing; without one the password has to be an argument, and the help says out loud
    // that an argument is visible in `ps`. A script that hid which of those it is doing would be a script whose
    // password ends up in a shell history file.
    expect(usage.toLowerCase()).toContain('prompt');
    expect(usage).toMatch(/without echoing/i);
    expect(usage).toMatch(/`ps`/);
  });
});
