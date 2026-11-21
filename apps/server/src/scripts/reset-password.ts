/**
 * `reset-password.ts` — the only supported password recovery (docs/plans/mvp/MVP-07.md §6).
 *
 * There is no email flow, no reset token, no "contact an admin": a self-hosted notes server has no outbound
 * mail and usually one user, who is the operator. This script is the answer to "I forgot my password", and it
 * is deliberately narrow about what it may touch:
 *
 * * **It writes two things**: `users.password_hash` with `password_set_at` (through `setUserPassword`, so the
 *   audit stamp cannot be forgotten), and a `DELETE` of that user's `sessions` rows. Nothing else.
 * * **It must never delete the user row**, however tempting that looks. Every other `user_id` foreign key in the
 *   schema is `ON DELETE CASCADE` (sessions, folders, notes, settings — `docs/DATA-MODEL.md`), so "delete the
 *   user and create them again" is *destruction of their notes*, followed by a `POST /api/auth/setup` that
 *   answers `409` because an owner row existed a moment ago. The integration test asserts the notes, folders and
 *   settings are all still there afterwards — the regression guard against anyone "simplifying" recovery into
 *   that.
 * * **An unknown username writes nothing.** Not a partial update and not a session sweep: the user is looked up
 *   first and the script exits non-zero before a statement runs, so a typo at 3 a.m. cannot lock anyone out
 *   harder.
 * * **No `auth_attempts` row.** That table records credential *checks*; this path never verifies the old
 *   password, and inventing a row for it would make "did anyone try to break in?" answerable only with noise.
 *   `users.password_set_at` is the evidence that this ran.
 *
 * ## How it is run
 *
 * TypeScript under `apps/server/src/`, so `pnpm build` emits `apps/server/dist/scripts/reset-password.js` and
 * production runs it inside the container (PR-18's `docs/DEPLOY.md` should carry this verbatim):
 *
 * ```
 * docker compose --env-file .env -f docker/compose.yml exec app \
 *   node apps/server/dist/scripts/reset-password.js <username>
 * ```
 *
 * In development it is `NODE_ENV=development pnpm --filter @note-taker/server exec tsx src/scripts/reset-password.ts
 * <username>`. Like every host entry point it needs `NODE_ENV` on its own command line (PR-01's rule), and it takes
 * `DATABASE_URL`/`POSTGRES_*` from the environment exactly as the server does — never a flag, so it cannot be pointed
 * at a database the operator did not mean to change.
 *
 * ## Where the new password comes from
 *
 * `argv` or an interactive prompt, and never a URL, a query string or an environment variable: `ps`, shell
 * history, `/proc`, CI logs and browser history all remember those. On a terminal the prompt does not echo;
 * without one the password has to be the second argument, which is why `--help` says so out loud instead of
 * pretending the argument is a bad way to do this.
 */
import process from 'node:process';

import { PASSWORD_MAX_LENGTH, passwordMatchesUsername, passwordSchema } from '@note-taker/contracts';

import { createArgon2Hasher, utf8ByteLength } from '../auth/passwords.js';
import { closeDb, getDb } from '../db/client.js';
import { deleteSessionsOfUser } from '../db/repositories/sessions.repo.js';
import { setUserPassword, userByUsername } from '../db/repositories/users.repo.js';
import { loadDevEnvFile, parseEnv } from '../env.js';

const SCRIPT_NAME = 'reset-password';

/** Anything the operator can fix by typing something else, reported as one line on stderr with exit `1`. */
class UsageError extends Error {}

const USAGE = `usage: ${SCRIPT_NAME} <username> [new-password]

Sets a new password for an existing account and signs that user out of every device.

On a terminal the new password is prompted for without echoing. Without a terminal it has to
be the second argument, which is visible in \`ps\` and in shell history, so run it from a
terminal when you have one. Nothing about this script is safe to put in a URL.`;

/**
 * The hidden prompt: raw mode, one `*` per key, and the bytes collected but never written.
 *
 * Not `readline`: `readline` in terminal mode *echoes* what it is given, which is the one thing a password
 * prompt may not do (a tmux capture, a screen recording, `script(1)`). Raw-mode input is read a byte at a time
 * and decoded once at the end, so a multi-byte character typed at the prompt survives instead of becoming a
 * different password than the one that was typed.
 */
async function readHiddenPassword(out: NodeJS.WritableStream): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new UsageError(
      'there is no terminal to prompt on: pass the new password as the second argument, and remember that `ps` and shell history will show it',
    );
  }
  out.write('New password: ');
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const bytes: number[] = [];
      const stop = (): void => {
        input.setRawMode(false);
        input.pause();
        input.removeAllListeners('data');
        input.removeAllListeners('error');
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          // `\r` is what a terminal sends on Enter (readline-style drivers send `\n`); Ctrl-C (0x03) is a real
          // interrupt, and backspace has to remove the `*` as well as the byte.
          if (byte === 0x0d || byte === 0x0a) {
            out.write('\n');
            stop();
            resolve(Buffer.from(bytes).toString('utf8'));
            return;
          }
          if (byte === 0x03) {
            stop();
            out.write('\n');
            reject(new UsageError('cancelled'));
            return;
          }
          if (byte === 0x7f || byte === 0x08) {
            if (bytes.length > 0) {
              bytes.pop();
              out.write('\b \b');
            }
            continue;
          }
          // Everything else a terminal can send — arrows, Home, an escape sequence — is a control code nobody
          // typed into a password on purpose, so it is dropped rather than appended.
          if (byte < 0x20) continue;
          bytes.push(byte);
          out.write('*');
        }
      };
      input.on('data', onData);
      input.once('error', (error: Error) => {
        stop();
        reject(error);
      });
    });
  } catch (error) {
    input.setRawMode(false);
    throw error;
  }
}

/** The password to set, from the argument when there is one and from the prompt when there is not. */
async function readNewPassword(fromArgv: string | undefined, out: NodeJS.WritableStream): Promise<string> {
  if (fromArgv !== undefined && fromArgv !== '') return fromArgv;
  return await readHiddenPassword(out);
}

/**
 * The policy the API enforces, applied here too.
 *
 * A recovery script that would set *any* string is a door: `POST /api/auth/password` refuses a 9-character
 * password and a password equal to the username, so a script that accepted them would be the way to install a
 * credential the API would then refuse to change. Same three rules, same schema.
 */
function assertUsablePassword(username: string, password: string): void {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    throw new UsageError(parsed.error.issues.map((issue) => `new password ${issue.message}`).join('; '));
  }
  if (utf8ByteLength(password) > PASSWORD_MAX_LENGTH) {
    throw new UsageError(`new password must be at most ${PASSWORD_MAX_LENGTH} bytes encoded as UTF-8`);
  }
  if (passwordMatchesUsername({ username, password })) {
    throw new UsageError('new password must not be the same as the username');
  }
}

export interface RunOptions {
  readonly argv: readonly string[];
  readonly out?: NodeJS.WritableStream;
  readonly err?: NodeJS.WritableStream;
}

/**
 * Everything the script does, over injected argv and streams, so the integration test can run the real thing
 * as a `tsx` subprocess against the test database and still assert on the exit code and what it printed.
 *
 * @returns the process exit code. `0` only when the password really was replaced.
 */
export async function run(options: RunOptions): Promise<number> {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const [username, passwordFromArgv] = options.argv;

  // The one path that prints usage *and* exits `2`: no username was given, so there is nothing to fix by
  // retyping a password and no `UsageError` to report. A `UsageError` — the name is about the operator's input,
  // not about this exit code — is always one line on stderr and exit `1`.
  if (username === undefined || username === '--help' || username === '-h') {
    (username === undefined ? err : out).write(`${USAGE}\n`);
    return username === undefined ? 2 : 0;
  }

  // Whether the database has been written to yet used to decide what the operator is told, and the reason it no
  // longer does is the reason this whole block is one transaction: once the hash was written and the revocation
  // had not run, "nothing was changed" would have been a lie, and the honest sentence sent people to `UPDATE
  // users` by hand with every session of the account still valid. There is no such middle state any more.
  try {
    const password = await readNewPassword(passwordFromArgv, out);
    assertUsablePassword(username, password);

    const { db } = getDb();
    const user = await userByUsername(db, username);
    if (user === undefined) {
      // Not "did you mean …": a recovery script that suggests account names is a user enumerator, and this one
      // runs on a box that may be reachable from the internet.
      throw new UsageError(`no account named ${username}`);
    }

    // Hashed outside the transaction: it is the half a second of argon2, and there is no reason to hold a row
    // lock on `users` through it (the same argument as `services/auth.service.ts`).
    const passwordHash = await createArgon2Hasher().hash(password);

    const revoked = await db.transaction(async (tx) => {
      const updated = await setUserPassword(tx, { userId: user.id, passwordHash });
      if (updated === undefined) {
        // Deleted between the read and the write. Not something a keyboard can do on purpose, and answering that
        // the password was set would be the worse lie.
        throw new UsageError(`no account named ${username}`);
      }

      // Every device goes, atomically with the new hash. The point of a reset is that whoever held the old
      // password cannot stay signed in, and unlike `POST /api/auth/password` there is no acting cookie to keep,
      // so this is the whole table for one user rather than the table minus one row.
      return await deleteSessionsOfUser(tx, { userId: user.id });
    });

    out.write(`password updated for ${user.username}; ${String(revoked)} session(s) signed out\n`);
    return 0;
  } catch (error) {
    const isUsage = error instanceof UsageError;
    err.write(`${SCRIPT_NAME}: ${isUsage ? error.message : describeUnexpected(error)}\n`);
    // True unconditionally now, which is what the transaction above buys: either both statements committed or
    // neither did, so a failure at any point leaves the old password and every old session exactly as they were.
    if (!isUsage) err.write(`${SCRIPT_NAME}: nothing was changed\n`);
    return 1;
  } finally {
    // The pool is the only reason this process could still be alive, and it is a singleton: closing it is what
    // lets a failed boot exit without holding a connection, and it is safe when no pool was ever opened.
    await closeDb();
  }
}

/** A driver or hashing failure, without whatever the driver put in its message (DSNs do appear there). */
function describeUnexpected(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Boot order identical to `index.ts`: dev `.env` if present, then parse, then work. */
async function main(): Promise<void> {
  loadDevEnvFile();
  parseEnv();
  process.exitCode = await run({ argv: process.argv.slice(2) });
}

/**
 * True when this file is the program being run, as opposed to a test importing `run`.
 *
 * `tsx src/scripts/reset-password.ts` and `node dist/scripts/reset-password.js` both put this file's path in
 * `argv[1]`; a Vitest worker puts its own, which is what keeps the guard from resetting a password in the
 * middle of somebody's test run.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && /(^|[\\/])reset-password\.(ts|js|mts|mjs|cjs)$/.test(entry);
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SCRIPT_NAME}: ${describeUnexpected(error)}\n`);
    process.exitCode = 1;
  });
}
