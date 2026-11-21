/**
 * The note-encryption keyring (docs/plans/mvp/MVP-06.md §5).
 *
 * One **current** key, tagged with the version from `NOTE_ENCRYPTION_KEY_VERSION` (default `1`), plus N
 * **previous** keys from `NOTE_ENCRYPTION_KEY_PREVIOUS` (a JSON map `{"1": "<base64>"}`) that exist only so rows
 * written under an older version keep decrypting during and after a rotation. `crypto/envelope.ts` reads this
 * structure; nothing here touches a database.
 *
 * Four rules this file owns:
 *
 * 1. **The current version is never derived.** Deriving it as `max(previous)+1` collapses back to `1` the moment
 *    `_PREVIOUS` is emptied, and every row tagged 2 becomes unreadable with nothing to show for it. The variable is
 *    explicit, and the operator bumps it by hand (MVP-06 §4).
 * 2. **A key that is set but wrong is a failure, never a fallback.** `env.ts` reports it in every mode; only
 *    "nothing configured at all" may reach rule 3.
 * 3. **Only `development` and `test` generate a key.** With nothing configured they create `.dev/note-key`
 *    (mode `0600`, directory on demand, gitignored) on first boot and reuse it afterwards, so dev rows survive a
 *    restart. That file is the key: delete it and every note written with it is gone — which is the point of the
 *    caveat, and the same test as production never taking this path.
 * 4. **Nothing here is logged except a fingerprint** (first 8 hex of `sha256(key)`), so an operator can tell which
 *    key a database was written with without the key ever crossing a log line.
 *
 * @see docs/plans/mvp/MVP-FULL-PLAN.md §10 (encryption at rest) and docs/DATA-MODEL.md §9 (what the columns hold).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { Logger } from 'pino';

import {
  decodeNoteEncryptionKey,
  EnvError,
  type EnvSource,
  keyProblems,
  LOG_LEVEL_VALUES,
  type LogLevel,
  missingNoteEncryptionKeyProblem,
  NOTE_ENCRYPTION_KEY_BYTES,
  type NoteEncryptionKeyVariable,
  nodeEnvOf,
  readNoteEncryptionKey,
  repoRoot,
} from '../env.js';
import { createLogger } from '../logger.js';

/** `NOTE_ENCRYPTION_KEY_VERSION`'s documented default (plan §16). */
export const DEFAULT_KEY_VERSION = 1;

/** `notes.key_version` is an `integer`, so a version above this cannot be written at all. */
export const MAX_KEY_VERSION = 2_147_483_647;

const KEY_VERSION_VARIABLE = 'NOTE_ENCRYPTION_KEY_VERSION';
const PREVIOUS_KEYS_VARIABLE = 'NOTE_ENCRYPTION_KEY_PREVIOUS';

/** The dev/test key lives here, at the workspace root, beside `.env` — and is gitignored with it. */
export const DEV_KEY_DIR_NAME = '.dev';
export const DEV_KEY_FILE_NAME = 'note-key';

/** The key that seals new rows, and the tag `crypto/envelope.ts` writes into `notes.key_version`. */
export interface CurrentKey {
  readonly version: number;
  readonly key: Uint8Array;
}

/**
 * Exactly the shape plan Appendix A.3 reads: `keyring.current.version` and `keyring.current.key`, with the
 * decrypt-only map beside it. Plain data, so a test can build one by hand.
 */
export interface Keyring {
  readonly current: CurrentKey;
  readonly previous: ReadonlyMap<number, Uint8Array>;
}

/** Where the current key came from, for the startup log line. */
export type KeySource = NoteEncryptionKeyVariable | 'dev-key';

export interface KeyringOptions {
  /** Env to read; defaults to `process.env`. Tests pass a fixture. */
  readonly source?: EnvSource;
  /** Where the fingerprint goes; defaults to the process logger for the mode being read. */
  readonly logger?: Logger;
  /**
   * Where a generated dev/test key is persisted. Defaults to `<repo root>/.dev`, and is a
   * **test seam**: the production-refusal test asserts this directory is never created.
   */
  readonly devKeyDir?: string;
}

/** The startup identity of one key: `sha256(key)`, first 8 hex. Never the key itself. */
export function keyFingerprint(key: Uint8Array): string {
  return createHash('sha256').update(key).digest().subarray(0, 4).toString('hex');
}

/** `NOTE_ENCRYPTION_KEY_VERSION`, or the default. A bad value is a problem, not a silent `1`. */
function parseKeyVersion(source: EnvSource, problems: string[]): number {
  const raw = source[KEY_VERSION_VARIABLE];
  if (raw === undefined || raw.trim() === '') return DEFAULT_KEY_VERSION;

  const value = raw.trim();
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < DEFAULT_KEY_VERSION || parsed > MAX_KEY_VERSION) {
    problems.push(
      `${KEY_VERSION_VARIABLE} must be an integer between ${DEFAULT_KEY_VERSION} and ${MAX_KEY_VERSION} ` +
        `(it is stamped into notes.key_version, an integer column) — got ${JSON.stringify(raw)}`,
    );
    return DEFAULT_KEY_VERSION;
  }
  return parsed;
}

/**
 * `NOTE_ENCRYPTION_KEY_PREVIOUS`: the JSON map of **older** keys, decrypt-only.
 *
 * Empty/absent is normal — it is only ever populated during a rotation. Every entry is validated
 * individually so one typo in a map with four entries does not hide the other three.
 */
function parsePreviousKeys(source: EnvSource, problems: string[]): Map<number, Uint8Array> {
  const previous = new Map<number, Uint8Array>();
  const raw = source[PREVIOUS_KEYS_VARIABLE];
  if (raw === undefined || raw.trim() === '') return previous;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Deliberately **not** `(error as Error).message`: V8 quotes a snippet of the input around the failing
    // position — `Unexpected token '"', "{"1":"AbCdEf…"… is not valid JSON` — and this variable holds key
    // material. The very mistake the hint below warns about (an unquoted inner value mangled by the shell)
    // would therefore print real key characters into the log this file promises carries only a fingerprint
    // (rule 4), on both boot and `rotate-note-key.ts`. The shape is all an operator needs to fix it.
    problems.push(
      `${PREVIOUS_KEYS_VARIABLE} must be a JSON object like {"1":"<base64>"} ` +
        '(in .env, write the whole value single-quoted so the shell can source the file)',
    );
    return previous;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push(
      `${PREVIOUS_KEYS_VARIABLE} must be a JSON object like {"1":"<base64>"}, not ${typeof parsed}`,
    );
    return previous;
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) {
      // The same rule as the parse failure above: an entry key is arbitrary operator text, and
      // `{ "<the base64 key>": … }` is a real typo shape, so the offending key's *shape* is reported and its
      // characters never are.
      problems.push(
        `${PREVIOUS_KEYS_VARIABLE} has an entry whose key is not a version number ` +
          `(${key.length} characters, not repeated here because this variable holds key material): ` +
          'keys are key versions, i.e. "1", "2", …',
      );
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${PREVIOUS_KEYS_VARIABLE}[${JSON.stringify(key)}] must be a base64 string`);
      continue;
    }
    const decoded = decodeNoteEncryptionKey(value, `${PREVIOUS_KEYS_VARIABLE}[${JSON.stringify(key)}]`);
    if (!decoded.ok) {
      problems.push(decoded.problem);
      continue;
    }
    previous.set(Number(key), decoded.bytes);
  }
  return previous;
}

/** The mode's default directory for a generated key. */
function devKeyDir(options: KeyringOptions): string {
  return options.devKeyDir ?? path.join(repoRoot(), DEV_KEY_DIR_NAME);
}

function devKeyFile(options: KeyringOptions): string {
  return path.join(devKeyDir(options), DEV_KEY_FILE_NAME);
}

/** A key on disk is a secret: repair a mode that a careless `cp` or an older tool left too open. */
function tightenKeyPermissions(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) chmodSync(file, 0o600);
}

function readDevKeyFile(file: string): Uint8Array {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    throw new EnvError([
      `cannot read the dev note-encryption key ${file}: ${(error as NodeJS.ErrnoException).code}`,
    ]);
  }
  const decoded = decodeNoteEncryptionKey(contents, `${DEV_KEY_FILE_NAME} (${file})`);
  if (!decoded.ok) {
    throw new EnvError([
      `${decoded.problem}. Delete ${file} to generate a fresh key — note bodies written with the old one ` +
        'are then unreadable, which is the documented dev caveat',
    ]);
  }
  tightenKeyPermissions(file);
  return decoded.bytes;
}

/**
 * The dev/test key: read `.dev/note-key`, or create it (directory on demand, file mode `0600`) and log the
 * fingerprint that every later boot must reproduce.
 *
 * `wx` on the write is deliberate: two processes booting at once must not each generate a key, so the loser
 * reads the winner's file instead of overwriting the one rows were just written with.
 *
 * @throws {EnvError} when the file exists but is not a key, or cannot be read or created.
 */
function loadOrCreateDevKey(options: KeyringOptions, logger: Logger): Uint8Array {
  const file = devKeyFile(options);
  if (existsSync(file)) return readDevKeyFile(file);

  const dir = devKeyDir(options);
  const fresh = randomBytes(NOTE_ENCRYPTION_KEY_BYTES);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${Buffer.from(fresh).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another process won the race: its key is the one this database will be read with.
    if (code === 'EEXIST') return readDevKeyFile(file);
    throw new EnvError([`cannot create the dev note-encryption key at ${file}: ${code}`]);
  }

  logger.info(
    { file, keyFingerprint: keyFingerprint(fresh) },
    'generated the dev note-encryption key: delete the file and every note written with it is unreadable',
  );
  return new Uint8Array(fresh);
}

function logKeyring(logger: Logger, keyring: Keyring, origin: KeySource): void {
  logger.info(
    {
      keyVersion: keyring.current.version,
      keyFingerprint: keyFingerprint(keyring.current.key),
      previousVersions: [...keyring.previous.keys()].sort((a, b) => a - b),
      keySource: origin,
    },
    'note encryption keyring ready',
  );
}

function logLevelOf(source: EnvSource): LogLevel {
  const raw = source.LOG_LEVEL;
  return (LOG_LEVEL_VALUES as readonly string[]).includes(typeof raw === 'string' ? raw.trim() : '')
    ? (raw as LogLevel)
    : 'info';
}

function loggerFor(options: KeyringOptions, source: EnvSource): Logger {
  if (options.logger !== undefined) return options.logger;
  return createLogger(logLevelOf(source), nodeEnvOf(source) ?? 'production');
}

/**
 * Resolves the current key, or records why there is not one.
 *
 * The three branches are the three rules of this file, in order: a usable configured key wins; a configured
 * but broken key is a problem (never a fallback to a generated one); only development and test may reach the
 * generated key. Returning `undefined` with nothing in `problems` means "production, nothing configured",
 * which `buildKeyring()` reports with {@link missingNoteEncryptionKeyProblem}.
 */
function resolveCurrentKey(
  options: KeyringOptions,
  source: EnvSource,
  logger: Logger,
  problems: string[],
): { readonly key: Uint8Array; readonly origin: KeySource } | undefined {
  const reading = readNoteEncryptionKey(source);
  if (reading.key !== undefined) return { key: reading.key, origin: reading.from ?? 'NOTE_ENCRYPTION_KEY' };

  // Rule 2: a key that is set but broken is a failure in every mode. Silently generating a dev key would
  // seal new rows with a key the operator never configured, next to rows they were trying to read.
  if (reading.configured) {
    problems.push(...keyProblems(reading));
    return undefined;
  }

  // Rule 3: only development and test may reach the generated key.
  const mode = nodeEnvOf(source);
  if (mode === 'development' || mode === 'test') {
    return { key: loadOrCreateDevKey(options, logger), origin: 'dev-key' };
  }

  // Production with nothing configured. `buildKeyring()` supplies the sentence, so that this process and
  // the boot guard in `env.ts` report the same problem from one place.
  return undefined;
}

/**
 * Builds the keyring from environment configuration, reporting every problem at once in the same
 * `EnvError` shape `parseEnv()` uses — both run at boot, and neither may leave a half-configured keyring
 * standing: an envelope sealed with an empty key is exactly the "plaintext by accident" state plan §10
 * refuses to have.
 *
 * @throws {EnvError} when nothing usable was configured in `production`, when a configured key is
 *   malformed in **any** mode, when `.dev/note-key` exists but is not a key, or when
 *   `NOTE_ENCRYPTION_KEY_PREVIOUS` shadows the current version.
 */
export function buildKeyring(options: KeyringOptions = {}): Keyring {
  const source = options.source ?? process.env;
  const logger = loggerFor(options, source);
  const problems: string[] = [];

  const version = parseKeyVersion(source, problems);
  const previous = parsePreviousKeys(source, problems);
  const resolved = resolveCurrentKey(options, source, logger, problems);

  if (previous.has(version)) {
    problems.push(
      `${PREVIOUS_KEYS_VARIABLE} may not carry the current version (${version}): that key would seal new rows ` +
        `while decrypt-only for the old ones. Bump ${KEY_VERSION_VARIABLE}, or drop the entry once no row uses it`,
    );
  }

  if (resolved === undefined || problems.length > 0) {
    throw new EnvError(problems.length > 0 ? problems : [missingNoteEncryptionKeyProblem()]);
  }

  const keyring: Keyring = { current: { version, key: resolved.key }, previous };
  logKeyring(logger, keyring, resolved.origin);
  return keyring;
}

/**
 * The process-wide keyring, like `getDb()`: the first call wins, so the app boots one keyring and logs one
 * fingerprint no matter how many callers ask for it.
 */
let keyring: Keyring | undefined;

export function getKeyring(options: KeyringOptions = {}): Keyring {
  keyring ??= buildKeyring(options);
  return keyring;
}

/** Test seam: forget the process-wide keyring (never needed by the app itself). */
export function resetKeyring(): void {
  keyring = undefined;
}
