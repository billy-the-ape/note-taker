/**
 * `check-env.ts` — the operator-facing preflight for a production `.env` (docs/plans/mvp/MVP-18.md),
 * wired as the root `pnpm check:env` script and documented variable by variable in `docs/DEPLOY.md` §4:
 *
 * ```
 * pnpm check:env                                        # DOTENV_PATH ?? <repo root>/.env
 * DOTENV_PATH=scripts/fixtures/prod-missing-key.env pnpm check:env
 * pnpm check:env --file scripts/fixtures/prod-no-dsn.env # the same, without the environment variable
 * ```
 *
 * ## It is a linter, not a boot path
 *
 * `apps/server/src/env.ts` is the boot guard and stays the authority: the container boots with `env.ts`
 * alone, and nothing under `docker/` runs this file. What this adds is the pre-flight an operator wants
 * before `up -d` — one report naming every problem in the file they are about to deploy, exit 1 on any of
 * them. A rule here that describes the same variable as a rule in `env.ts` copies `env.ts`'s wording, so an
 * operator who is told to change something twice hears the same sentence twice.
 *
 * ## Why it reads the file itself instead of calling `loadDevEnvFile()`
 *
 * Wrong twice over: `loadDevEnvFile()` (`apps/server/src/env.ts`) is a no-op when `NODE_ENV=production` (by design, PR-01 — a file
 * must never pick a mode), and it merges into `process.env`, so a preflight built on it would validate the
 * *shell* rather than the file and would report nothing at all in exactly the mode it exists for. This file
 * therefore has its own parser and judges the operator's `.env` as text, whether or not the shell running
 * the preflight happens to export the same keys.
 *
 * ## The one rule that cannot be copied verbatim: the DSN
 *
 * The **guard** fails an unset *process* `DATABASE_URL` in production, which is right, because inside the
 * stack Compose has already composed it (`docker/compose.yml` derives it from `POSTGRES_*` with host `db`).
 * The **linter** only ever sees the file, and the documented production `.env` deliberately carries the
 * `POSTGRES_*` trio and **no** DSN line — `databaseUrl()` derives it, and one `POSTGRES_PORT` edit then
 * moves the dev container and every host tool together. So the linter accepts **either** form, fails only a
 * file that has neither, and warns when both are present and disagree. Without that carve-out the runbook's
 * own `.env` could never pass its own preflight.
 *
 * ## What it never does
 *
 * It never contacts Docker, a database or a key server; it never reads the file `NOTE_ENCRYPTION_KEY_FILE`
 * names (that path exists inside the container); and it never echoes a value that could be key material —
 * base64 in a terminal is base64 in a ticket. Values are judged by shape and length only.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── the variables, exactly as the §4 configuration reference lists them ──────────────────────────

/** Every documented key, so an unknown one is at least worth a warning. */
const KNOWN_KEYS: readonly string[] = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'HOST_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_PORT',
  'DATABASE_URL',
  'DB_POOL_MAX',
  'SESSION_TTL_DAYS',
  'SECURE_COOKIES',
  'TRUST_PROXY',
  'ALLOW_REGISTRATION',
  'NOTE_ENCRYPTION_KEY',
  'NOTE_ENCRYPTION_KEY_FILE',
  'NOTE_ENCRYPTION_KEY_PREVIOUS',
  'NOTE_ENCRYPTION_KEY_VERSION',
  'LOGIN_RATE_LIMIT_MAX',
  'MAX_NOTE_BYTES',
  'LOG_LEVEL',
  'APP_NAME',
];

/** The documented defaults, quoted in the warnings so an operator can see what they are not setting. */
const DOCUMENTED_DEFAULTS = new Map<string, string>([
  ['HOST', '0.0.0.0'],
  ['PORT', '3000 (pinned by compose.yml inside the container)'],
  ['HOST_PORT', '3000'],
  ['POSTGRES_USER', 'notetaker (but required in the file whenever compose is used)'],
  ['POSTGRES_PASSWORD', 'notetaker (but required in the file: the runbook shell reads it)'],
  ['POSTGRES_DB', 'notetaker (but required in the file: the restore drill derives <db>_restore from it)'],
  ['POSTGRES_PORT', '5432 (dev-only; the prod db publishes nothing)'],
  ['DB_POOL_MAX', '10'],
  ['SESSION_TTL_DAYS', '30'],
  ['SECURE_COOKIES', 'false'],
  ['TRUST_PROXY', 'false'],
  ['ALLOW_REGISTRATION', 'false'],
  ['NOTE_ENCRYPTION_KEY_VERSION', '1'],
  ['LOGIN_RATE_LIMIT_MAX', '10'],
  ['MAX_NOTE_BYTES', '1048576'],
  ['LOG_LEVEL', 'info'],
  ['APP_NAME', 'Note Taker'],
]);

const KEY_CURRENT = 'NOTE_ENCRYPTION_KEY';
const KEY_FILE = 'NOTE_ENCRYPTION_KEY_FILE';
const KEY_PREVIOUS = 'NOTE_ENCRYPTION_KEY_PREVIOUS';
const KEY_VERSION = 'NOTE_ENCRYPTION_KEY_VERSION';
const DATABASE_URL = 'DATABASE_URL';
const DSN_TRIO: readonly string[] = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'];

const LOG_LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

/** `NOTE_ENCRYPTION_KEY_VERSION`'s documented default — `ENV_DEFAULTS` in `env.ts`, same number. */
const DEFAULT_KEY_VERSION = 1;

/** Copied from `env.ts`: an AES-256 key is 32 bytes, and nothing else is accepted, in any mode. */
const NOTE_ENCRYPTION_KEY_BYTES = 32;

/** Copied from `env.ts`: stricter than `Buffer.from(…, 'base64')`, which silently discards junk. */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Copied from `env.ts`: `[A-Za-z0-9]+` is the only shape safe to embed in a DSN, because both DSN
 * compositions (`databaseUrl()` and compose.yml's `environment:` line) embed the trio **raw** and nothing
 * percent-encodes on the way.
 */
const DSN_SAFE = /^[A-Za-z0-9]+$/;
const RESERVED_IN_URL = '@ : / + % ? #';

/** `notes.key_version` is an `integer`, so a version above this cannot be written at all. */
const MAX_KEY_VERSION = 2_147_483_647;

/** The variables `docker/compose.yml` pins, so a line here is inert inside the stack and worth naming. */
const OVERSHADOWED_BY_COMPOSE = new Map<string, string>([
  ['PORT', '3000 — `HOST_PORT` is the operator-facing knob'],
  [DATABASE_URL, 'postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB'],
]);

// ── finding the file ─────────────────────────────────────────────────────────────────────────────

/**
 * The first directory at or above `startDir` holding `pnpm-workspace.yaml` — the same marker `env.ts`'s
 * `repoRoot()` walks to, because a fixed `../../` is wrong as soon as this file is run from elsewhere.
 */
function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Where to read, and why: `--file` beats `DOTENV_PATH` beats the repo root, exactly as documented. */
export type Target =
  | { readonly kind: 'file'; readonly file: string; readonly from: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'unfound'; readonly reason: string };

/**
 * `--file <path>` (also `--file=<path>`, also `-f`) exists so CI and the fixtures can be judged **without**
 * putting their contents in the runner's environment; `DOTENV_PATH` is the documented override an operator
 * already knows from `env.ts`; the fallback is `<repo root>/.env`, i.e. `dotenvPath()`'s rule, re-expressed
 * here because this file may not import the loader it is deliberately independent of.
 */
export function resolveTarget(argv: readonly string[], env: NodeJS.ProcessEnv): Target {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  const index = argv.findIndex((arg) => arg === '--file' || arg === '-f' || arg.startsWith('--file='));
  if (index !== -1) {
    const arg = argv[index] as string;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('-')) {
      return { kind: 'unfound', reason: '--file needs a path' };
    }
    return { kind: 'file', file: value, from: '--file' };
  }

  const override = env.DOTENV_PATH;
  if (typeof override === 'string' && override.trim() !== '') {
    return { kind: 'file', file: override.trim(), from: 'DOTENV_PATH' };
  }

  const root = findRepoRoot(process.cwd());
  if (root === undefined) {
    return {
      kind: 'unfound',
      reason:
        'no pnpm-workspace.yaml at or above the current directory, so there is no repo root to read .env ' +
        'from: run this from the repo root, or pass --file / DOTENV_PATH',
    };
  }
  return { kind: 'file', file: path.join(root, '.env'), from: 'the repo root' };
}

// ── the parser: the operator's file, as text ─────────────────────────────────────────────────────

/** A `KEY=value` line that at least one of the file's two readers would not read the way it looks. */
export interface MalformedLine {
  readonly line: number;
  readonly reason: string;
  readonly found: string;
}

/** The file's variables, plus the lines that are not variables and the keys assigned twice. */
export interface ParsedDotenv {
  /** Key → value, quotes already stripped, in file order. A key assigned twice keeps the first. */
  readonly values: Map<string, string>;
  /**
   * Key → the quote that wrapped its value, for the one rule that is *about* the quotes: Compose strips
   * exactly one layer, so `NOTE_ENCRYPTION_KEY_PREVIOUS` has to be single-quoted to survive both readers.
   */
  readonly quotes: ReadonlyMap<string, Quote>;
  readonly malformed: MalformedLine[];
  readonly duplicates: MalformedLine[];
}

/** Short, single-line, quote-safe excerpt — and never of a key (see this file's header). */
function preview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return JSON.stringify(oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine);
}

/**
 * Keys whose *value* is a secret. A preflight runs in a terminal an operator may be recording, and its
 * output ends up in tickets, so a problem is named by shape and length instead of by content — the same
 * reason `env.ts` never logs key material. (An unsafe `POSTGRES_PASSWORD` is reported as a shape problem
 * even though `env.ts` itself prints the offending value.)
 */
const SECRET_KEYS: readonly string[] = [KEY_CURRENT, KEY_PREVIOUS, 'POSTGRES_PASSWORD', DATABASE_URL];

/** `preview`, except a secret contributes its length and nothing else. */
function previewValue(name: string, value: string): string {
  if (SECRET_KEYS.includes(name)) return `<${value.trim().length} chars, not printed>`;
  return preview(value);
}

const EXPORT_LINE = /^export\s+[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const OPENING_QUOTE = /^['"]/;

/** The quote a value was wrapped in, if any. */
export type Quote = '"' | "'";

/**
 * Strips one matching pair of surrounding quotes and reports which one. Node 22's `process.loadEnvFile`
 * and Compose's `--env-file` both strip exactly one layer, and that is the shape both hand the process — it
 * is also why the runbook writes `NOTE_ENCRYPTION_KEY_PREVIOUS` single-quoted: the quotes Compose strips
 * for the container are exactly the ones a shell would otherwise choke on.
 */
function unwrapQuotes(value: string): {
  readonly text: string;
  readonly quote?: Quote;
  readonly unbalanced: boolean;
} {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return { text: value, unbalanced: false };
  if (value.length < 2 || !value.endsWith(quote)) return { text: value, unbalanced: true };
  return { text: value.slice(1, -1), quote, unbalanced: false };
}

/**
 * Reads the file the way its two readers do: whole lines, no `${VAR}` expansion (`process.loadEnvFile`
 * performs none, and Compose only interpolates inside the Compose file), and a comment is a comment only
 * where a shell or Compose would treat it as one.
 *
 * Deliberately strict. Every rejection here is a line whose value at least one of the two readers gets
 * wrong, and a wrong `POSTGRES_PASSWORD` is a container that cannot reach its own database.
 */
export function parseDotenv(text: string): ParsedDotenv {
  const values = new Map<string, string>();
  const quotes = new Map<string, Quote>();
  const malformed: MalformedLine[] = [];
  const duplicates: MalformedLine[] = [];
  const firstLineOf = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    if (EXPORT_LINE.test(trimmed)) {
      malformed.push({
        line,
        reason:
          '"export" is shell syntax that Compose does not understand, and the runbook sources this very ' +
          'file with `set -a; . ./.env; set +a`, which already exports every line: drop the "export "',
        found: preview(trimmed),
      });
      return;
    }

    const match = ASSIGNMENT.exec(trimmed);
    if (!match) {
      malformed.push({
        line,
        reason: 'not a KEY=value line (a comment needs "#" at the start of the line)',
        found: preview(trimmed),
      });
      return;
    }

    const key = match[1] as string;
    const rawValue = (match[2] as string).trim();

    // An unquoted `#` is a comment to Compose and literal text to a sourced shell, so the two readers would
    // disagree about the value. Neither is allowed to win quietly.
    if (!OPENING_QUOTE.test(rawValue) && rawValue.includes(' #')) {
      malformed.push({
        line,
        reason:
          'an inline "#" is a comment to Compose and literal text to a sourced shell; put the comment on ' +
          'its own line',
        found: preview(rawValue),
      });
      return;
    }

    const unwrapped = unwrapQuotes(rawValue);
    if (unwrapped.unbalanced) {
      malformed.push({
        line,
        reason:
          'the value opens a quote it never closes: Compose hands the container the quote mark itself, and ' +
          'a sourcing shell waits for the closing quote',
        found: preview(rawValue),
      });
      return;
    }
    const value = unwrapped.text;

    const previous = firstLineOf.get(key);
    if (previous !== undefined) {
      duplicates.push({
        line,
        reason: `${key} is assigned twice (line ${previous} and line ${line}): one of the two values is ignored`,
        found: preview(value),
      });
      return;
    }
    firstLineOf.set(key, line);
    values.set(key, value);
    if (unwrapped.quote !== undefined) quotes.set(key, unwrapped.quote);
  });

  return { values, quotes, malformed, duplicates };
}

// ── the rules ────────────────────────────────────────────────────────────────────────────────────

/** What one run of the linter found. Anything in `problems` is exit 1; `warnings` never is. */
export interface EnvReport {
  readonly file: string;
  readonly problems: string[];
  readonly warnings: string[];
}

/** The rules' shared view of the file: read access, plus the two sinks. */
class Report {
  private readonly values: ReadonlyMap<string, string>;

  private readonly quotes: ReadonlyMap<string, Quote>;

  readonly problems: string[] = [];

  readonly warnings: string[] = [];

  constructor(values: ReadonlyMap<string, string>, quotes: ReadonlyMap<string, Quote>) {
    this.values = values;
    this.quotes = quotes;
  }

  /** The quote that wrapped this key's value in the file, or `undefined` when it was written bare. */
  quote(key: string): Quote | undefined {
    return this.quotes.get(key);
  }

  /** The value as written, including the empty string; `undefined` when the key is not in the file. */
  raw(key: string): string | undefined {
    return this.values.get(key);
  }

  /** The trimmed value, or `undefined` when absent, empty or whitespace-only — `env.ts`'s rule. */
  value(key: string): string | undefined {
    const value = this.values.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  isSet(key: string): boolean {
    return this.values.has(key);
  }

  /** Every key in the file, in file order. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  /** Present but blank: the `printf` that produced `NOTE_ENCRYPTION_KEY=` with nothing after it. */
  isSetButEmpty(key: string): boolean {
    return this.values.has(key) && (this.values.get(key) as string).trim() === '';
  }

  /** True when any of these keys is present-but-blank, so a "missing" rule does not describe it twice. */
  anyBlank(keys: readonly string[]): boolean {
    return keys.some((key) => this.isSetButEmpty(key));
  }

  fail(problem: string): void {
    this.problems.push(problem);
  }

  note(warning: string): void {
    this.warnings.push(warning);
  }

  integer(name: string, minValue: number, maxValue: number): number | undefined {
    const raw = this.value(name);
    if (raw === undefined) return undefined;
    if (!/^-?\d+$/.test(raw)) {
      this.fail(`${name} must be an integer (got ${preview(raw)})`);
      return undefined;
    }
    const value = Number(raw);
    if (value < minValue || value > maxValue) {
      this.fail(`${name} must be an integer between ${minValue} and ${maxValue} (got ${value})`);
      return undefined;
    }
    return value;
  }

  boolean(name: string): boolean | undefined {
    const raw = this.value(name);
    if (raw === undefined) return undefined;
    const value = raw.toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    this.fail(`${name} must be true or false (got ${preview(raw)})`);
    return undefined;
  }

  /** The `[A-Za-z0-9]+` rule of `env.ts`, spelled once. */
  requireUrlSafe(name: string, value: string): void {
    if (DSN_SAFE.test(value)) return;
    this.fail(
      `${name} must match [A-Za-z0-9]+ because it is embedded raw in the Postgres DSN — nothing ` +
        `percent-encodes on the way, and ${RESERVED_IN_URL} are reserved ` +
        `(got ${previewValue(name, value)}). Generate a password with \`openssl rand -hex 32\`.`,
    );
  }
}

/** 32 base64 bytes or the sentence that says so; the same shape check `env.ts`'s decoder runs. */
function keyProblem(label: string, value: string): string | undefined {
  if (!BASE64_ONLY.test(value)) {
    return `${label} must be base64 ([A-Za-z0-9+/], optionally padded with =) — this is not`;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== NOTE_ENCRYPTION_KEY_BYTES) {
    return `${label} must decode to exactly ${NOTE_ENCRYPTION_KEY_BYTES} bytes (AES-256), got ${bytes.length}`;
  }
  return undefined;
}

/**
 * The absence sentence of `env.ts`'s `missingNoteEncryptionKeyProblem()`, **adapted** rather than copied: the
 * boot guard tells a process to generate a key with `node -e "…"`, which presupposes a repository checkout to
 * run it in, and this linter runs on exactly the host that does not have one — so the same failure is told in
 * the one form that host can act on (`docker run --rm node:22-slim …`). The rule is shared and deliberately so;
 * the wording is not, and neither message quotes the other.
 */
function missingKeyProblem(): string {
  return (
    `no note-encryption key: set ${KEY_CURRENT} to base64 for 32 bytes or ${KEY_FILE} to a readable ` +
    'file containing it. A production host generates one with its Docker and no repository checkout: ' +
    'docker run --rm node:22-slim node -e ' +
    '\'console.log(require("crypto").randomBytes(32).toString("base64"))\'. ' +
    'There is no plaintext mode: development and test generate a key and persist it to .dev/note-key, ' +
    'production refuses to boot'
  );
}

/** §4: `NODE_ENV` is required — but not *in this file*, because the image and compose.yml set it. */
function checkNodeEnv(report: Report): void {
  const value = report.value('NODE_ENV');
  if (value === undefined || value === 'production') return;
  report.fail(
    `NODE_ENV=${preview(value)}: the production image bakes NODE_ENV=production and docker/compose.yml ` +
      'repeats it in the app service, so this line is inert inside the stack and wrong outside it — a ' +
      'sourced .env would boot the app in a mode where the production invariants of env.ts are not armed. ' +
      'Delete the line (the image is what sets the mode).',
  );
}

/** PR-06: the current key from either variable, the version tag that is never derived, the old keys. */
function checkNoteKey(report: Report): void {
  const inline = report.value(KEY_CURRENT);
  const file = report.value(KEY_FILE);

  if (inline === undefined && file === undefined) {
    if (!report.anyBlank([KEY_CURRENT, KEY_FILE])) report.fail(missingKeyProblem());
  } else if (inline !== undefined) {
    const problem = keyProblem(KEY_CURRENT, inline);
    if (problem !== undefined) report.fail(problem);
  }

  if (file !== undefined) {
    // The linter cannot open it: the path names a file inside the container, not one the preflight can see.
    if (!path.isAbsolute(file)) {
      report.fail(
        `${KEY_FILE} must be an absolute path inside the container (got ${preview(file)}): crypto/keys.ts ` +
          'reads it in the app process, not the shell that runs this preflight',
      );
    }
    report.note(
      `${KEY_FILE} is set, but docker/compose.yml still requires ${KEY_CURRENT}: its required-value ` +
        'interpolation cannot express either/or. The mounted-key variant is the documented edit to that ' +
        'file: add the volume, keep this variable, delete the required-value line (docs/DEPLOY.md §3).',
    );
  }

  // Absent means 1, exactly as `env.ts`'s `ENV_DEFAULTS` has it: a file that omits the version and lists
  // `{"1": …}` in `_PREVIOUS` *is* holding its own current key, whether or not the operator wrote the line.
  const version = report.integer(KEY_VERSION, 1, MAX_KEY_VERSION) ?? DEFAULT_KEY_VERSION;

  const previous = report.value(KEY_PREVIOUS);
  if (previous === undefined) return;

  // The quoting is a rule of its own, before the JSON is even parsed. Compose strips exactly one quote
  // layer for the container, and the runbook sources the same file in a shell where bare `{…}` with double
  // quotes inside is a syntax error — so the JSON has to arrive at both readers wrapped in exactly one pair
  // of *single* quotes, which is what `docs/DEPLOY.md` §7 step 2 writes.
  const quote = report.quote(KEY_PREVIOUS);
  if (quote === undefined) {
    report.fail(
      `${KEY_PREVIOUS} is not quoted, so \`. ./.env\` reads its braces and double quotes as shell syntax ` +
        'and fails before a container is ever built (and Compose would hand the process the bare JSON, so ' +
        'the two readers disagree about a key). Write the whole value single-quoted: ' +
        `${KEY_PREVIOUS}='{"1":"<base64>"}'.`,
    );
    return;
  }
  if (quote === '"') {
    report.fail(
      `${KEY_PREVIOUS} is double-quoted. Compose strips that outer pair and hands the process the escaped ` +
        `quotes inside, which is not JSON; a sourcing shell unescapes them and hands it something else. ` +
        `Single-quote the value instead: ${KEY_PREVIOUS}='{"1":"<base64>"}'.`,
    );
    return;
  }

  // The JSON has to survive both readers at once: Compose strips one quote layer for the container, and the
  // runbook sources the same file in a shell where bare `{…}` with double quotes inside is a syntax error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(previous) as unknown;
  } catch {
    report.fail(
      `${KEY_PREVIOUS} is not JSON by the time the process sees it ` +
        `(${previewValue(KEY_PREVIOUS, previous)}). Write it ` +
        `single-quoted — ${KEY_PREVIOUS}='{"1":"<base64>"}' — so Compose strips exactly one layer and ` +
        '`set -a; . ./.env; set +a` stays valid shell.',
    );
    return;
  }
  if (previous.includes("'")) {
    report.fail(
      `${KEY_PREVIOUS} contains a single quote, so the line cannot be single-quoted either: the JSON must ` +
        'not contain one of its own',
    );
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    report.fail(
      `${KEY_PREVIOUS} must be a JSON object like {"1":"<base64>"} ${previewValue(KEY_PREVIOUS, previous)}`,
    );
    return;
  }
  for (const [tag, material] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > MAX_KEY_VERSION) {
      report.fail(
        `${KEY_PREVIOUS} keys must be positive integer versions within notes.key_version (got ` +
          `${preview(tag)}): the key is moved here as \`{"<old version>": "<old base64>"}\``,
      );
      continue;
    }
    if (typeof material !== 'string') {
      report.fail(`${KEY_PREVIOUS}[${tag}] must be a base64 string`);
      continue;
    }
    const problem = keyProblem(`${KEY_PREVIOUS}[${tag}]`, material);
    if (problem !== undefined) report.fail(problem);
    if (version !== undefined && Number(tag) === version) {
      report.fail(
        `${KEY_PREVIOUS} holds the current version ${tag}: the map is decrypt-only and holds *older* keys, ` +
          `while ${KEY_VERSION} is the current one. A rotation is ${KEY_VERSION}=<old>+1 with the old key ` +
          'moved into the map, in one edit (docs/DEPLOY.md §7).',
      );
    }
  }
}

/**
 * The DSN carve-out described in this file's header: either form is accepted, neither present is a failure,
 * and both present and disagreeing is a warning — the same comparison and the same level as
 * `env.ts`'s `warnDatabaseUrlMismatch()`.
 */
function checkDatabase(report: Report): void {
  const user = report.value('POSTGRES_USER');
  const password = report.value('POSTGRES_PASSWORD');
  const database = report.value('POSTGRES_DB');
  const port = report.value('POSTGRES_PORT');
  const dsn = report.value(DATABASE_URL);

  for (const [name, value] of [
    ['POSTGRES_USER', user],
    ['POSTGRES_PASSWORD', password],
    ['POSTGRES_DB', database],
  ] as const) {
    if (value !== undefined) report.requireUrlSafe(name, value);
  }

  const hasTrio = user !== undefined && password !== undefined && database !== undefined;
  const blankDsnKeys = report.anyBlank([...DSN_TRIO, DATABASE_URL]);
  if (!hasTrio && dsn === undefined && !blankDsnKeys) {
    report.fail(
      `no database to connect to: set ${DATABASE_URL} verbatim, or set the trio ${DSN_TRIO.join(', ')} ` +
        'and let docker/compose.yml compose the DSN with host `db`. The documented production .env carries ' +
        `the trio and no ${DATABASE_URL} line, and the container needs one: env.ts never derives it in ` +
        'production. Note the trio is required in the file either way — Compose interpolates it into the ' +
        'DSN, and the runbook sources it for `pg_dump`.',
    );
  }
  if (dsn !== undefined && !hasTrio) {
    report.note(
      `${DATABASE_URL} is set without the full ${DSN_TRIO.join(', ')} trio: compose.yml composes the ` +
        'container DSN from the trio in its `environment:` block, which beats `env_file:`, so this line ' +
        'never reaches the container as written. To point the stack at an external database, edit ' +
        'compose.yml (delete the composed DATABASE_URL) and keep the trio, which is what `pg_dump` and the ' +
        'restore drill run on.',
    );
  }
  if (dsn === undefined) return;

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    report.fail(
      `${DATABASE_URL} is not a URL an operator can read ${previewValue(DATABASE_URL, dsn)}: it is used ` +
        'verbatim, so a character that needs percent-encoding never gets it',
    );
    return;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    report.fail(`${DATABASE_URL} must be a postgres:// or postgresql:// URL (got ${preview(url.protocol)})`);
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    report.note(
      `${DATABASE_URL} points at localhost, and inside the stack the database is the service \`db\`: an app ` +
        'container has no Postgres of its own. Compose derives a `db` DSN from the trio unless compose.yml ' +
        'was edited to take this one.',
    );
  }
  if (port !== undefined) {
    report.note(
      'POSTGRES_PORT is dev-only: it appears in docker/compose.dev.yml alone, the production db publishes ' +
        'nothing, and the container DSN is composed with service port 5432 (docs/DEPLOY.md §4).',
    );
  }
  if (!hasTrio) return;

  const dsnPort = url.port !== '' ? url.port : '5432';
  const dsnDatabase = decodeURIComponentSafely(url.pathname.replace(/^\//, ''));
  const disagreements: string[] = [];
  if (port !== undefined && port !== dsnPort)
    disagreements.push(`POSTGRES_PORT=${port} (the DSN uses ${dsnPort})`);
  if (database !== undefined && database !== dsnDatabase) {
    disagreements.push(`POSTGRES_DB=${database} (the DSN uses ${dsnDatabase})`);
  }
  if (disagreements.length > 0) {
    report.note(
      `${DATABASE_URL} disagrees with ${disagreements.join(' and ')}. The DSN is used verbatim and does ` +
        'not track later edits to the POSTGRES_* values, so keep them in sync or delete the ' +
        `${DATABASE_URL} line (docs/DEPLOY.md §9).`,
    );
  }
}

/** Anything the file pins that compose.yml pins harder, so an operator learns it is inert in the container. */
function checkOvershadowed(report: Report): void {
  for (const [key, pinned] of OVERSHADOWED_BY_COMPOSE) {
    if (report.value(key) === undefined) continue;
    report.note(
      `${key} is set here, but compose.yml pins it to ${pinned}; inside the container it is inert.`,
    );
  }
}

function checkNumbers(report: Report): void {
  const sessionTtl = report.integer('SESSION_TTL_DAYS', 1, 3_650);
  if (sessionTtl !== undefined && sessionTtl > 365) {
    report.fail(
      `SESSION_TTL_DAYS must be <= 365 in production (got ${sessionTtl}): a session that outlives a year ` +
        'is a larger theft window than the data is worth',
    );
  }
  report.integer('DB_POOL_MAX', 1, 1_000);
  report.integer('LOGIN_RATE_LIMIT_MAX', 1, 1_000_000);
  report.integer('MAX_NOTE_BYTES', 1_024, 1_073_741_824);
  report.integer('HOST_PORT', 1, 65_535);

  const logLevel = report.value('LOG_LEVEL');
  if (logLevel !== undefined && !LOG_LEVELS.includes(logLevel)) {
    report.fail(`LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')} (got ${preview(logLevel)})`);
  }
}

// `HOST` and `APP_NAME` need no non-empty rule of their own: a blank one is named by `checkBlankLines`.

/** The three cross-field rules `env.ts`'s `productionInvariants()` enforces at boot, mirrored here. */
function checkInvariants(report: Report): void {
  const secure = report.boolean('SECURE_COOKIES');
  const proxy = report.boolean('TRUST_PROXY');
  const open = report.boolean('ALLOW_REGISTRATION');
  if (secure === false && proxy === true) {
    report.fail(
      'SECURE_COOKIES must be true when TRUST_PROXY is true in production: TRUST_PROXY means TLS is ' +
        'terminated upstream, so a plaintext session cookie is a choice, not an accident',
    );
  }
  if (secure === false && open === true) {
    report.fail(
      'SECURE_COOKIES must be true when ALLOW_REGISTRATION is true in production: never hand out session ' +
        'cookies over plain HTTP',
    );
  }
}

/** An empty value is a decision nobody made, so it is named — unless a rule above already named it. */
function checkBlankLines(report: Report): void {
  for (const key of [...report.keys()]) {
    if (!report.isSetButEmpty(key)) continue;
    const documented = DOCUMENTED_DEFAULTS.get(key);
    report.fail(
      `${key} is set but empty (nothing after the equals sign): fill the line or delete it` +
        (documented === undefined
          ? ''
          : ` — its documented default is ${documented}, and an empty value is not that default`) +
        '. The `printf` of docs/DEPLOY.md §2 produces exactly this shape when its command substitution ' +
        'fails, and an empty secret is a worse surprise than a missing one.',
    );
  }
}

function checkKnownKeys(report: Report, parsed: ParsedDotenv): void {
  for (const key of parsed.values.keys()) {
    if (KNOWN_KEYS.includes(key)) continue;
    report.note(
      `${key} is not a variable of docs/DEPLOY.md §4, so nothing reads it — not Compose, not env.ts, not ` +
        'this preflight. Delete it rather than leave a value nobody honours (a mode is never taken from ' +
        'this file, and the dev-only Vite knob is not a deploy setting).',
    );
  }
}

/** Every rule, in the order an operator fixes them: mode → key → database → numbers → invariants. */
export function checkDotenv(file: string, parsed: ParsedDotenv): EnvReport {
  const report = new Report(parsed.values, parsed.quotes);

  for (const bad of parsed.malformed) report.fail(`line ${bad.line}: ${bad.reason} — found ${bad.found}`);
  for (const duplicate of parsed.duplicates) report.fail(`line ${duplicate.line}: ${duplicate.reason}`);

  checkNodeEnv(report);
  checkNoteKey(report);
  checkDatabase(report);
  checkNumbers(report);
  checkInvariants(report);
  checkBlankLines(report);
  checkOvershadowed(report);
  checkKnownKeys(report, parsed);

  return { file, problems: report.problems, warnings: report.warnings };
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const USAGE = `check-env — preflight a production .env (docs/plans/mvp/MVP-18.md §4)

  pnpm check:env                                          # DOTENV_PATH ?? <repo root>/.env
  DOTENV_PATH=scripts/fixtures/prod-missing-key.env pnpm check:env
  pnpm check:env --file scripts/fixtures/prod-no-dsn.env  # the same, without the environment variable

Exit codes: 0 the file satisfies every documented production rule, 1 it does not,
2 there was no file to judge. Warnings never change the exit code.
`;

/** `2` is reserved for "there was no file to judge", so an exit 0 always means a file was judged. */
export function renderReport(
  report: EnvReport,
  write: { readonly out: (line: string) => void; readonly err: (line: string) => void },
): number {
  for (const warning of report.warnings) write.out(`warning: ${warning}`);
  if (report.problems.length === 0) {
    write.out(
      report.warnings.length === 0
        ? `${report.file}: ok — every documented production rule holds`
        : `${report.file}: ok with ${report.warnings.length} warning(s) — nothing blocks the deploy`,
    );
    return 0;
  }
  write.err(`${report.file}: ${report.problems.length} problem(s)`);
  for (const problem of report.problems) write.err(`  - ${problem}`);
  write.err('docs/DEPLOY.md §4 is the configuration reference and §9 the troubleshooting table.');
  return 1;
}

function main(): number {
  const target = resolveTarget(process.argv.slice(2), process.env);
  if (target.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (target.kind === 'unfound') {
    process.stderr.write(`check-env: cannot locate an environment file: ${target.reason}.\n`);
    return 2;
  }

  const file = path.resolve(target.file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
    process.stderr.write(
      `check-env: cannot read ${file} (from ${target.from}): ${code}. Create it with the steps in ` +
        'docs/DEPLOY.md §2, or point --file / DOTENV_PATH at the file you meant.\n',
    );
    return 2;
  }

  return renderReport(checkDotenv(file, parseDotenv(text)), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

process.exitCode = main();
