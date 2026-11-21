/**
 * The one place this repository reads `process.env`.
 *
 * Four entry points, and later PRs may not build a fifth way of reaching the same values
 * (docs/plans/mvp/MVP-FULL-PLAN.md §16):
 *
 *   * `parseEnv()` — Zod-parsed configuration that fails fast with a readable LIST of problems.
 *   * `loadDevEnvFile()` — loads the repo-root `.env` into `process.env` for host processes only.
 *   * `databaseUrl()` — the single Postgres DSN resolver (`db/client.ts`, `db/migrate.ts`,
 *     `drizzle.config.ts` and `scripts/seed-demo.ts` all go through it, in PR-04/PR-09).
 *   * `readNoteEncryptionKey()` / `noteEncryptionKeyBytes()` — the single reader of the note-encryption
 *     key material (PR-06), which is what lets the production boot guard below and `crypto/keys.ts`
 *     apply one rule rather than two. Building the *keyring* (versions, `_PREVIOUS`, the dev key file)
 *     is `crypto/keys.ts`, on top of these bytes.
 *
 * The rule the rest of the file is organised around: **`NODE_ENV` is required and never
 * defaulted**, in every environment. A container that forgot it must not boot in the
 * least-restrictive mode, and because the gate reads the value already in the *process*
 * environment, a line in `.env` can never supply it — that is why every host script declares its
 * own mode on its own command line (`NODE_ENV=development tsx …`, `NODE_ENV=test vitest …`) and
 * why nothing here papers over a missing value with a default.
 *
 * Keys outside the schema (PATH, HOME, SHLVL, …) are ignored on purpose: `process.env` is a shared
 * namespace, so "unknown" is enforced per variable (an unknown *value*, e.g.
 * `LOG_LEVEL=verbose`) rather than by refusing to start next to `PATH`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

export const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENV_VALUES)[number];

/** The pino levels `LOG_LEVEL` accepts; `silent` is reachable via `createLogger()` in code only. */
export const LOG_LEVEL_VALUES = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

/** Anything shaped like `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Every problem found in one boot, already human-readable. Thrown instead of booting half-configured. */
export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const list = problems.length > 0 ? problems : ['no problem was reported (this is a bug)'];
    super(`invalid environment configuration:\n${list.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'EnvError';
    this.problems = list;
  }
}

/** The variables and their documented defaults (plan §16), as raw strings so one table rules all. */
const ENV_DEFAULTS = {
  HOST: '0.0.0.0',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DB_POOL_MAX: '10',
  SESSION_TTL_DAYS: '30',
  SECURE_COOKIES: 'false',
  TRUST_PROXY: 'false',
  ALLOW_REGISTRATION: 'false',
  LOGIN_RATE_LIMIT_MAX: '10',
  MAX_NOTE_BYTES: '1048576',
  APP_NAME: 'Note Taker',
  /**
   * The version tag `crypto/envelope.ts` stamps into `notes.key_version` for the *current* key
   * (PR-06). It is a variable of its own and never derived from `NOTE_ENCRYPTION_KEY_PREVIOUS`:
   * deriving it as `max(previous)+1` collapses back to `1` the moment the map is emptied and silently
   * orphans every row tagged 2.
   */
  NOTE_ENCRYPTION_KEY_VERSION: '1',
} as const;

function booleanFrom(name: string) {
  return z.string().transform((raw, ctx) => {
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    ctx.addIssue({ code: 'custom', message: `${name} must be true or false (got ${JSON.stringify(raw)})` });
    return z.NEVER;
  });
}

function integerFrom(name: string, { minValue, maxValue }: { minValue: number; maxValue?: number }) {
  return z.string().transform((raw, ctx) => {
    const value = raw.trim();
    if (!/^-?\d+$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: `${name} must be an integer (got ${JSON.stringify(raw)})` });
      return z.NEVER;
    }
    const parsed = Number(value);
    const range = maxValue === undefined ? `>= ${minValue}` : `between ${minValue} and ${maxValue}`;
    if (parsed < minValue || (maxValue !== undefined && parsed > maxValue)) {
      ctx.addIssue({ code: 'custom', message: `${name} must be an integer ${range} (got ${parsed})` });
      return z.NEVER;
    }
    return parsed;
  });
}

const envShape = z.object({
  NODE_ENV: z.enum(NODE_ENV_VALUES, {
    error: `is required and is never defaulted; must be one of ${NODE_ENV_VALUES.join(' | ')} (a container that forgets it must not boot in the least-restrictive mode)`,
  }),
  HOST: z.string().min(1, { error: 'HOST must be a non-empty address to bind' }),
  PORT: integerFrom('PORT', { minValue: 1, maxValue: 65_535 }),
  LOG_LEVEL: z.enum(LOG_LEVEL_VALUES),
  DB_POOL_MAX: integerFrom('DB_POOL_MAX', { minValue: 1, maxValue: 1_000 }),
  SESSION_TTL_DAYS: integerFrom('SESSION_TTL_DAYS', { minValue: 1, maxValue: 3_650 }),
  SECURE_COOKIES: booleanFrom('SECURE_COOKIES'),
  TRUST_PROXY: booleanFrom('TRUST_PROXY'),
  ALLOW_REGISTRATION: booleanFrom('ALLOW_REGISTRATION'),
  LOGIN_RATE_LIMIT_MAX: integerFrom('LOGIN_RATE_LIMIT_MAX', { minValue: 1, maxValue: 1_000_000 }),
  MAX_NOTE_BYTES: integerFrom('MAX_NOTE_BYTES', { minValue: 1_024, maxValue: 1_073_741_824 }),
  APP_NAME: z.string().min(1, { error: 'APP_NAME must be a non-empty title' }),
  /**
   * The note-encryption key material (PR-06). Only the *shape* is checked here; the value is read by
   * {@link readNoteEncryptionKey}, because a key that is set but wrong has to be reported in
   * development and test too, where the production boot guard below is not armed.
   */
  NOTE_ENCRYPTION_KEY: z.string().optional(),
  /** Alternative to the variable above: the key lives in a mounted file, so it never appears in a shell. */
  NOTE_ENCRYPTION_KEY_FILE: z.string().optional(),
  /** JSON map `{"1": "<base64>"}` of **older** keys; decrypt-only, and only during a rotation. */
  NOTE_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  // The upper bound is `notes.key_version`'s: it is an `integer`, so a version above this could be
  // configured and then fail on the first write (crypto/keys.ts applies the same range).
  NOTE_ENCRYPTION_KEY_VERSION: integerFrom('NOTE_ENCRYPTION_KEY_VERSION', {
    minValue: 1,
    maxValue: 2_147_483_647,
  }),
});

/** The validated configuration of one process. */
export type Env = z.infer<typeof envShape>;

/** The env with defaults applied, minus keys that are unset, empty, or whitespace-only. */
function withDefaults(source: EnvSource): Record<string, string> {
  const merged: Record<string, string> = { ...ENV_DEFAULTS };
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === 'string' && raw.trim() !== '') merged[key] = raw;
  }
  return merged;
}

/** Zod's issue already names the offending key in `path[0]`; render it as `VAR: why`. */
function formatIssues(
  issues: readonly { readonly path: readonly unknown[]; readonly message: string }[],
): string[] {
  return issues.map((issue) => {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'environment';
    return `${key}: ${issue.message}`;
  });
}

// ── the note-encryption key (PR-06) ──────────────────────────────────────────────────────────────
//
// Reading the *variables* is env's job, because the production boot guard below has to apply the same
// rule the keyring builder will, and two implementations of "did the operator hand us 32 bytes" drift
// the first time one of them is fixed. Turning those bytes into a keyring — the versioned current key
// plus the decrypt-only `_PREVIOUS` map — is `crypto/keys.ts`.

/** An AES-256 key is 32 bytes. Nothing else is accepted, in any environment, ever. */
export const NOTE_ENCRYPTION_KEY_BYTES = 32;

/** The two variables that can supply the *current* key, in the order they are tried. */
export const NOTE_ENCRYPTION_KEY_VARIABLES = ['NOTE_ENCRYPTION_KEY', 'NOTE_ENCRYPTION_KEY_FILE'] as const;
export type NoteEncryptionKeyVariable = (typeof NOTE_ENCRYPTION_KEY_VARIABLES)[number];

/**
 * `[A-Za-z0-9+/]+={0,2}` — deliberately stricter than `Buffer.from(…, 'base64')`, which silently
 * discards anything outside the alphabet. A URL-safe key (`-`/`_`), a key with a space in it, or a
 * truncated one must be a reported failure, not a *different key* that decrypts nothing.
 */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/** A key that is present, or the sentence that tells an operator how to fix it. */
export type DecodedKey =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly problem: string };

/** `[A-Za-z0-9+/]` with optional `=` padding: the two readers of this file agree on this shape. */
function isConfigured(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Decodes one base64 key.
 *
 * @param label the name that appears in the failure text — the variable, or the variable plus the file
 *   it names, so a bad key inside `NOTE_ENCRYPTION_KEY_FILE` is not mistaken for the inline one.
 */
export function decodeNoteEncryptionKey(
  raw: string,
  label: string = NOTE_ENCRYPTION_KEY_VARIABLES[0],
): DecodedKey {
  const value = raw.trim();
  if (value === '') return { ok: false, problem: `${label} is set but empty` };
  if (!BASE64_ONLY.test(value)) {
    return {
      ok: false,
      problem: `${label} must be base64 ([A-Za-z0-9+/], optionally padded with =) — this is not`,
    };
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== NOTE_ENCRYPTION_KEY_BYTES) {
    return {
      ok: false,
      problem: `${label} must decode to exactly ${NOTE_ENCRYPTION_KEY_BYTES} bytes (AES-256), got ${bytes.length}`,
    };
  }
  // Not the `Buffer`: every caller of this function is the crypto layer, and the schema's `bytea`
  // columns are typed `Uint8Array` (docs/DATA-MODEL.md §1).
  return { ok: true, bytes: new Uint8Array(bytes) };
}

/** The reason nothing was configured at all — the sentence the boot guard and the keyring share. */
export function missingNoteEncryptionKeyProblem(): string {
  return (
    `no note-encryption key: set ${NOTE_ENCRYPTION_KEY_VARIABLES[0]} to base64 for 32 bytes ` +
    `or ${NOTE_ENCRYPTION_KEY_VARIABLES[1]} to a readable file containing it (generate one with ` +
    "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`. There is no " +
    'plaintext mode: development and test generate a key and persist it to .dev/note-key, production refuses to boot'
  );
}

/** Reads the key out of a mounted file. A trailing newline is tolerated, because that is what `echo` writes. */
function readKeyFile(file: string): DecodedKey {
  const label = `${NOTE_ENCRYPTION_KEY_VARIABLES[1]} (${file})`;
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
    return { ok: false, problem: `${label} could not be read: ${code}` };
  }
  return decodeNoteEncryptionKey(contents, label);
}

/** What the configured key material amounted to. */
export interface NoteEncryptionKeyReading {
  /** The current key; absent exactly when there is something an operator has to be told about. */
  readonly key?: Uint8Array;
  /** Which variable it came from, for the startup log line. */
  readonly from?: NoteEncryptionKeyVariable;
  /** Everything wrong with what was configured; empty when nothing was configured at all. */
  readonly problems: readonly string[];
  /**
   * `true` when either variable is set. A key that is set but broken is **never** replaced by a
   * generated dev key: that would encrypt new rows with a key nobody configured and leave the rows
   * the operator was trying to read exactly as unreadable as before.
   */
  readonly configured: boolean;
}

/**
 * Reads the *current* note-encryption key from `NOTE_ENCRYPTION_KEY`, or from
 * `NOTE_ENCRYPTION_KEY_FILE` when only that is set (a mounted secret file, with no shell in the way).
 *
 * Reports rather than throws: `parseEnv()` needs every production problem at once, and
 * `crypto/keys.ts` needs to tell "nothing configured" (the dev/test generated key) apart from
 * "configured badly" (a failure in every mode).
 */
export function readNoteEncryptionKey(source: EnvSource = process.env): NoteEncryptionKeyReading {
  const inline = source.NOTE_ENCRYPTION_KEY;
  const file = source.NOTE_ENCRYPTION_KEY_FILE;

  if (isConfigured(inline)) {
    const decoded = decodeNoteEncryptionKey(inline);
    // A readable file next to a broken inline key is not a fallback: the operator set one of the two
    // wrong, and quietly using the other is how a database gets written with a key nobody meant.
    return decoded.ok
      ? { key: decoded.bytes, from: NOTE_ENCRYPTION_KEY_VARIABLES[0], problems: [], configured: true }
      : { problems: [decoded.problem], configured: true };
  }

  if (isConfigured(file)) {
    const decoded = readKeyFile(file.trim());
    return decoded.ok
      ? { key: decoded.bytes, from: NOTE_ENCRYPTION_KEY_VARIABLES[1], problems: [], configured: true }
      : { problems: [decoded.problem], configured: true };
  }

  return { problems: [], configured: false };
}

/** The problem list for a reading that found no key, whether or not anything was configured. */
export function keyProblems(reading: NoteEncryptionKeyReading): readonly string[] {
  return reading.problems.length > 0 ? reading.problems : [missingNoteEncryptionKeyProblem()];
}

/**
 * The current key, or an {@link EnvError} naming the variable to set.
 *
 * Use this when a process may simply not continue without a key (`crypto/keys.ts`). Use
 * {@link readNoteEncryptionKey} when the caller has its own report to write.
 */
export function noteEncryptionKeyBytes(source: EnvSource = process.env): Uint8Array {
  const reading = readNoteEncryptionKey(source);
  if (reading.key === undefined) throw new EnvError(keyProblems(reading));
  return reading.key;
}

/**
 * The cross-field rules that only bite in production (plan §10). PR-06 armed the note-encryption key
 * here; the rate limiter and CSRF pair arrive in PR-07, and `scripts/check-env.ts` (PR-18) mirrors
 * these rules for an operator-facing preflight that judges the repo-root `.env` instead of the process.
 *
 * The key rule reads the **raw source** rather than the parsed `env`, because the value it has to
 * judge is a file (`NOTE_ENCRYPTION_KEY_FILE`), and `Env` is the parsed shape (plan §16).
 */
function productionInvariants(env: Env, source: EnvSource): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (env.SESSION_TTL_DAYS > 365) {
    problems.push(
      `SESSION_TTL_DAYS must be <= 365 in production (got ${env.SESSION_TTL_DAYS}): a session that outlives a year is a larger theft window than the data is worth`,
    );
  }
  if (!env.SECURE_COOKIES && env.TRUST_PROXY) {
    problems.push(
      'SECURE_COOKIES must be true when TRUST_PROXY is true in production: TRUST_PROXY means TLS is terminated upstream, so a plaintext session cookie is a choice, not an accident',
    );
  }
  if (env.ALLOW_REGISTRATION && !env.SECURE_COOKIES) {
    problems.push(
      'SECURE_COOKIES must be true when ALLOW_REGISTRATION is true in production: never hand out session cookies over plain HTTP',
    );
  }
  const key = readNoteEncryptionKey(source);
  if (key.key === undefined) problems.push(...keyProblems(key));
  return problems;
}

/**
 * Parses a `process.env`-shaped object (defaults to the real one) into typed configuration.
 *
 * @throws {EnvError} listing every problem at once — missing required variables, unknown values,
 *   and violated production invariants.
 */
export function parseEnv(source: EnvSource = process.env): Env {
  const merged = withDefaults(source);
  const result = envShape.safeParse(merged);
  if (!result.success) throw new EnvError(formatIssues(result.error.issues));

  const env = result.data;
  const problems = productionInvariants(env, merged);
  if (problems.length > 0) throw new EnvError(problems);
  return env;
}

/**
 * The workspace root: the first directory at or above `startDir` that contains
 * `pnpm-workspace.yaml`.
 *
 * A fixed `../../.env` is wrong — under `tsx` from `apps/server/src/` it resolves to
 * `apps/.env`, and the depth changes again once the file is compiled into `apps/server/dist/`.
 * Walking up to a marker file is the one expression that stays true in all three places.
 */
export function repoRoot(startDir: string = import.meta.dirname ?? process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new EnvError([
        `cannot locate the workspace root: no pnpm-workspace.yaml at or above ${startDir} ` +
          '(loadDevEnvFile() needs it to find the repo-root .env)',
      ]);
    }
    dir = parent;
  }
}

/**
 * The file `loadDevEnvFile()` reads: `$DOTENV_PATH`, else `<repo root>/.env`.
 *
 * The `?? process.cwd()` on the default is for `drizzle.config.ts`, the one consumer that is not run as ESM:
 * drizzle-kit bundles the config graph to CommonJS, where `import.meta.dirname` is `undefined` and
 * `path.resolve(undefined)` fails with Node's `paths[0]` type error instead of anything naming this file. Both
 * walk-up defaults (`dotenvPath()` and `repoRoot()`) keep the same fallback so the two cannot drift.
 */
export function dotenvPath(
  source: EnvSource = process.env,
  startDir: string = import.meta.dirname ?? process.cwd(),
): string {
  const override = source.DOTENV_PATH;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return path.join(repoRoot(startDir), '.env');
}

/** `NODE_ENV` as a validated mode, or `undefined` when it is absent, empty or unrecognised. */
export function nodeEnvOf(source: EnvSource): NodeEnv | undefined {
  const value = source.NODE_ENV;
  return typeof value === 'string' && (NODE_ENV_VALUES as readonly string[]).includes(value.trim())
    ? (value.trim() as NodeEnv)
    : undefined;
}

/**
 * Loads the repo-root `.env` into `process.env` for host-run entry points: `index.ts` (dev
 * server), the Vitest setup file of `vitest.integration.config.ts` and `drizzle.config.ts`
 * (PR-04), and `scripts/seed-demo.ts` (PR-09).
 *
 * * a no-op unless the **process** `NODE_ENV` is `development` or `test`;
 * * path = `DOTENV_PATH ?? <repo root>/.env` (see `dotenvPath()`);
 * * `process.loadEnvFile` (Node 22 built-in, so no `dotenv` dependency) does not overwrite keys
 *   that are already set — **the environment beats the file**, and it performs no `${VAR}`
 *   expansion, so a `DATABASE_URL` written here is a literal;
 * * only `ENOENT` is swallowed: a missing file is the normal state of a bare clone, while any
 *   other failure (a directory, an unreadable path) must fail loudly. Node 22's parser is
 *   lenient about file *content*, so a read failure is what "malformed" can mean here.
 */
export function loadDevEnvFile(source: EnvSource = process.env): void {
  const mode = nodeEnvOf(source);
  if (mode !== 'development' && mode !== 'test') return;

  const file = dotenvPath(source);
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new EnvError([
      `cannot read the environment file ${file}: ${(error as Error).message} ` +
        '(only a missing file is tolerated; DOTENV_PATH can point elsewhere)',
    ]);
  }
}

/** `[A-Za-z0-9]+`: the only shape safe to embed in a DSN, because nothing percent-encodes on the way. */
const DSN_SAFE = /^[A-Za-z0-9]+$/;
const RESERVED_IN_URL = '@ : / + % ? #';

/** Defaults for the dev/test derivation only; production has no default DSN at all. */
const DSN_DEFAULTS = {
  POSTGRES_USER: 'notetaker',
  POSTGRES_PASSWORD: 'notetaker',
  POSTGRES_DB: 'notetaker',
  POSTGRES_PORT: '5432',
} as const;

/** The once-per-process latch behind `warnDatabaseUrlMismatch()`. */
let warnedAboutDatabaseUrl = false;

/** Test seam: the disagreement warning is deliberately emitted at most once per process. */
export function resetDatabaseUrlWarning(): void {
  warnedAboutDatabaseUrl = false;
}

export interface DatabaseUrlOptions {
  /** Sink for the single "the file disagrees with itself" warning; defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

function dsnComponent(name: string, value: string | undefined, fallback: string): string {
  const component = value ?? fallback;
  if (!DSN_SAFE.test(component)) {
    throw new EnvError([
      `${name} must match [A-Za-z0-9]+ because it is embedded raw in the Postgres DSN — nothing ` +
        `percent-encodes on the way, and ${RESERVED_IN_URL} are reserved (got ${JSON.stringify(component)}). ` +
        'Generate a password with `openssl rand -hex 32`, or set DATABASE_URL verbatim instead.',
    ]);
  }
  return component;
}

function localPort(value: string | undefined): string {
  const port = value ?? DSN_DEFAULTS.POSTGRES_PORT;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new EnvError([
      `POSTGRES_PORT must be an integer between 1 and 65535 (got ${JSON.stringify(port)})`,
    ]);
  }
  return port;
}

/**
 * Warns once when an explicit `DATABASE_URL` and the `POSTGRES_*` values that would have produced
 * it disagree, naming both — the trap this prevents is silently connecting to a different database
 * than the container the operator just re-published (plan §16).
 */
function warnDatabaseUrlMismatch(
  databaseUrl: string,
  source: EnvSource,
  warn: (message: string) => void,
): void {
  if (warnedAboutDatabaseUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return; // Not a URL this can compare (e.g. a socket path): nothing to warn about.
  }

  const port = parsed.port !== '' ? parsed.port : DSN_DEFAULTS.POSTGRES_PORT;
  const database = decodedURIComponentSafely(parsed.pathname.replace(/^\//, ''));
  const disagreements: string[] = [];
  if (
    source.POSTGRES_PORT !== undefined &&
    source.POSTGRES_PORT.trim() !== '' &&
    source.POSTGRES_PORT.trim() !== port
  ) {
    disagreements.push(`POSTGRES_PORT=${source.POSTGRES_PORT.trim()} (the DSN uses ${port})`);
  }
  if (
    source.POSTGRES_DB !== undefined &&
    source.POSTGRES_DB.trim() !== '' &&
    source.POSTGRES_DB.trim() !== database
  ) {
    disagreements.push(`POSTGRES_DB=${source.POSTGRES_DB.trim()} (the DSN uses ${database})`);
  }
  if (disagreements.length === 0) return;

  warnedAboutDatabaseUrl = true;
  warn(
    `DATABASE_URL disagrees with ${disagreements.join(' and ')}. The DSN is used verbatim and does ` +
      'not track later edits to the POSTGRES_* values (`process.loadEnvFile` expands nothing), so keep ' +
      'them in sync or delete the DATABASE_URL line — see docs/plans/mvp/MVP-FULL-PLAN.md §16.',
  );
}

function decodedURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The single Postgres DSN resolver. Nothing else in the repository may build a DSN ad hoc.
 *
 * 1. `DATABASE_URL` set (process env or `.env`) → used **verbatim**.
 * 2. Unset and `NODE_ENV` is `development`/`test` → derived from `POSTGRES_*` with `notetaker`
 *    defaults on host `localhost` (this branch only runs outside containers; inside the stack
 *    Compose supplies its own DSN with host `db`, plan §15).
 * 3. Unset and `NODE_ENV=production` → no derivation and no default: it fails naming `DATABASE_URL`.
 *
 * A mode that is absent or unrecognised fails too: no mode means no permission to derive.
 *
 * @throws {EnvError} naming the variable that is missing or unusable.
 */
export function databaseUrl(source: EnvSource = process.env, options: DatabaseUrlOptions = {}): string {
  const explicit = source.DATABASE_URL;
  const mode = nodeEnvOf(source);

  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const value = explicit.trim();
    if (mode === 'development' || mode === 'test') {
      warnDatabaseUrlMismatch(value, source, options.warn ?? ((message) => console.warn(message)));
    }
    return value;
  }

  if (mode === undefined) {
    throw new EnvError([
      'NODE_ENV is required before a Postgres DSN can be resolved: DATABASE_URL is unset and ' +
        `derivation from POSTGRES_* is only allowed in ${NODE_ENV_VALUES.filter((value) => value !== 'production').join('/')}`,
    ]);
  }
  if (mode === 'production') {
    throw new EnvError([
      'DATABASE_URL is required in production: it has no default and is never derived there ' +
        '(inside the Compose stack the app service supplies it from POSTGRES_* with host `db`, plan §15)',
    ]);
  }

  const user = dsnComponent('POSTGRES_USER', source.POSTGRES_USER, DSN_DEFAULTS.POSTGRES_USER);
  const password = dsnComponent(
    'POSTGRES_PASSWORD',
    source.POSTGRES_PASSWORD,
    DSN_DEFAULTS.POSTGRES_PASSWORD,
  );
  const database = dsnComponent('POSTGRES_DB', source.POSTGRES_DB, DSN_DEFAULTS.POSTGRES_DB);
  const port = localPort(source.POSTGRES_PORT);
  return `postgres://${user}:${password}@localhost:${port}/${database}`;
}
