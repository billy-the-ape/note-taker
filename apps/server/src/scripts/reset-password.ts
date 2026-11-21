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

import {
  PASSWORD_EQUALS_USERNAME_MESSAGE,
  PASSWORD_MAX_LENGTH,
  passwordMatchesUsername,
  passwordSchema,
} from '@note-taker/contracts';

import { createArgon2Hasher, utf8ByteLength } from '../auth/passwords.js';
import { closeDb, getDb } from '../db/client.js';
import { deleteSessionsOfUser } from '../db/repositories/sessions.repo.js';
import { couldBeAnAccountName, setUserPassword, userByUsername } from '../db/repositories/users.repo.js';
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
 * Removes the last **character** of the buffer and returns how many bytes that was (`0` for an empty one).
 *
 * The prompt collects raw bytes and decodes once, at Enter, because raw-mode input is a byte stream; that is
 * also what makes an edit wrong rather than merely ugly. `bytes.pop()` on `päss` leaves `0xC3` (the lead byte of
 * `ä`) as the whole buffer, `Buffer.from([0xc3]).toString('utf8')` is `'\uFFFD'`, and the script would then
 * enforce the length rules on, hash, and commit a password the operator never typed and cannot retype — through
 * the only recovery path this product has, in the same transaction that signs the account out of every device.
 *
 * A UTF-8 character is one lead byte followed by continuation bytes (`10xxxxxx`), so those go first and the byte
 * that starts them goes with them. A well-formed buffer has at most three continuation bytes to drain; a
 * malformed one — unreachable from a terminal, cheap to survive — drains every trailing one it is holding
 * instead of stopping at an assumed count, and never leaves half a character behind.
 */
export function popLastCharacter(bytes: number[]): number {
  let removed = 0;
  while (bytes.length > 0 && ((bytes[bytes.length - 1] as number) & 0xc0) === 0x80) {
    bytes.pop();
    removed += 1;
  }
  if (bytes.length > 0) {
    bytes.pop();
    removed += 1;
  }
  return removed;
}

/**
 * Where in an escape sequence a raw-mode terminal has left the prompt.
 *
 * `text` is the only interesting state: it means the next byte is either the operator's password or a key with
 * a name (Enter, Ctrl-C, Backspace). `escaped` is a lone `ESC`, and `sequence` is everything an introducer
 * opens — the body grammar below is the same for `ESC [` (CSI: arrows, Home, Delete, most function keys, and
 * bracketed paste) and `ESC O` (SS3: F1–F4 and, on some terminals, the arrows), including their modified
 * forms (`ESC [ 1 ; 5 A`, `ESC O 1 ; 5 P`).
 */
export type EscapePhase =
  | { readonly kind: 'text' }
  | { readonly kind: 'escaped' }
  | { readonly kind: 'sequence' };

/** `text`, named so a caller does not have to know which of the three variants that is. */
export const TEXT_PHASE: EscapePhase = { kind: 'text' };

export interface FeedRequest {
  /** The buffer as the previous chunk left it. */
  readonly bytes: readonly number[];
  /** The phase as the previous chunk left it — escape sequences arrive split across reads. */
  readonly phase: EscapePhase;
  /** One raw-mode read. */
  readonly chunk: readonly number[];
}

export interface FeedResult {
  /** The buffer after the chunk. */
  readonly bytes: number[];
  readonly phase: EscapePhase;
  /** How many `*` to draw (one per character, not one per byte). */
  readonly draw: number;
  /** How many characters to erase from the display. */
  readonly erase: number;
  /** Set when the chunk contained Enter or Ctrl-C; the rest of that chunk is dropped. */
  readonly stop: 'submit' | 'cancel' | undefined;
}

/**
 * Applies one raw-mode read to the prompt's buffer, as a pure function of `(bytes, phase, chunk)`.
 *
 * Two bugs of the same shape were found in this loop by review, and both are the same mistake: treating a
 * terminal's bytes as if they were characters. The first was backspace popping one byte of a multi-byte
 * character ({@link popLastCharacter}). The second was this: skipping bytes below `0x20` "drops the escape
 * sequence", but an arrow key is `ESC [ A` = `1b 5b 41`, and only the `1b` is below `0x20` — so `↑` used to add
 * `[A` to someone's password and draw two `*`, on the one recovery path there is, in the same transaction that
 * signs the account out of every device. Home (`ESC [ H`), Delete (`ESC [ 3 ~`) and the function keys do the
 * same, and a paste or a bracketed-paste marker can put the `ESC` in a different read from the rest of it,
 * which is why the phase is carried in and out rather than the sequence being assumed to fit in one chunk.
 *
 * The machine fails closed: every byte of a sequence is consumed and none of it is typed, and `sequence` always
 * exits on the following byte, so it can never swallow the next Enter. `ESC` followed by something that is not
 * an introducer reprocesses that byte as text, because the operator's `b` is not part of a stray escape.
 */
export function feedPasswordInput(request: FeedRequest): FeedResult {
  const bytes = [...request.bytes];
  let phase = request.phase;
  let draw = 0;
  let erase = 0;

  for (const byte of request.chunk) {
    let typed: number | undefined = byte;
    if (phase.kind !== 'text') {
      const step = advanceEscape(phase, byte);
      phase = step.phase;
      if (step.consumed) typed = undefined;
    }
    if (typed === undefined) continue;

    // `\r` is what a terminal sends on Enter; readline-style drivers send `\n`. Ctrl-C (0x03) is a real
    // interrupt, and it is honoured rather than dropped, because "cancelled" must not look like a submission.
    if (typed === 0x0d || typed === 0x0a) return { bytes, phase, draw, erase, stop: 'submit' };
    if (typed === 0x03) return { bytes, phase, draw, erase, stop: 'cancel' };

    if (typed === 0x7f || typed === 0x08) {
      // One *character*, not one byte: popping `0xA4` and leaving `0xC3` behind would hash, commit and report
      // success for U+FFFD. Exactly one `*` was drawn for that character, so one `\b \b` takes it away.
      if (popLastCharacter(bytes) > 0) erase += 1;
      continue;
    }

    if (typed === 0x1b) {
      phase = { kind: 'escaped' };
      continue;
    }
    // Any other control byte (Tab, Bell, Ctrl-D, Ctrl-W…) is not something a password on this prompt contains,
    // and the alternative — putting it in the buffer — is the bug class this function exists to end.
    if (typed < 0x20) continue;

    bytes.push(typed);
    // A continuation byte (`10xxxxxx`) belongs to the character its lead byte started, so drawing a `*` only
    // for the others keeps the one-glyph-per-keystroke promise for `ä`, `日` and `😀` alike.
    if ((typed & 0xc0) !== 0x80) draw += 1;
  }

  return { bytes, phase, draw, erase, stop: undefined };
}

/** Consumes one byte of an escape sequence; `consumed: false` means the byte is ordinary input after all. */
function advanceEscape(
  phase: EscapePhase,
  byte: number,
): { readonly phase: EscapePhase; readonly consumed: boolean } {
  if (phase.kind === 'escaped') {
    if (byte === 0x5b /* [ for CSI */ || byte === 0x4f /* O for SS3 */) {
      return { phase: { kind: 'sequence' }, consumed: true };
    }
    // A lone `ESC`, or `ESC` in front of a second `ESC`: nothing was being introduced, so the byte counts.
    return { phase: TEXT_PHASE, consumed: false };
  }
  // Parameter bytes `0x30–0x3f` (`0-9 : ; < = > ?`) and intermediate bytes `0x20–0x2f` extend the sequence;
  // a final byte `0x40–0x7e` ends it. Anything else ends it too and is still not typed: the prompt has no
  // business believing a terminal it does not understand, and every wrong guess here can only refuse to add a
  // character, never invent one.
  if ((byte >= 0x30 && byte <= 0x3f) || (byte >= 0x20 && byte <= 0x2f)) return { phase, consumed: true };
  return { phase: TEXT_PHASE, consumed: true };
}

/**
 * The hidden prompt: raw mode, one `*` per character, and the bytes collected but never written.
 *
 * Not `readline`: `readline` in terminal mode *echoes* what it is given, which is the one thing a password
 * prompt may not do (a tmux capture, a screen recording, `script(1)`). Everything the bytes mean is decided by
 * {@link feedPasswordInput}, which is pure and therefore tested: multi-byte characters survive editing, and
 * keys with names never reach the buffer.
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
      let buffer: readonly number[] = [];
      let phase: EscapePhase = TEXT_PHASE;
      const stop = (): void => {
        input.setRawMode(false);
        input.pause();
        input.removeAllListeners('data');
        input.removeAllListeners('error');
      };
      const onData = (chunk: Buffer): void => {
        const fed = feedPasswordInput({ bytes: buffer, phase, chunk: [...chunk] });
        buffer = fed.bytes;
        phase = fed.phase;
        if (fed.draw > 0) out.write('*'.repeat(fed.draw));
        if (fed.erase > 0) out.write('\b \b'.repeat(fed.erase));
        if (fed.stop === 'submit') {
          out.write('\n');
          stop();
          resolve(Buffer.from(fed.bytes).toString('utf8'));
        } else if (fed.stop === 'cancel') {
          stop();
          out.write('\n');
          reject(new UsageError('cancelled'));
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
    // The contract's words for §10's second rule, prefixed the way every other refusal here is: the script and
    // the API are the same policy spoken by two processes, and they must not drift into two policies.
    throw new UsageError(`new password ${PASSWORD_EQUALS_USERNAME_MESSAGE}`);
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
    // `userByUsername` refuses to ask the database about a name it cannot hold (the SQLSTATE 22021 note lives in
    // `users.repo.ts`), so the lookup below would answer `undefined` and print "no account named …" — the right
    // verdict reached by the wrong route, and one that echoes the operator's typo back at them, which a terminal
    // renders by truncating the line a NUL lands on. Say it in the script's own voice, before the password is
    // even asked for.
    if (!couldBeAnAccountName(username)) {
      throw new UsageError('the username contains a character that cannot be part of an account name');
    }

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
