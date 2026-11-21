import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EnvError, NOTE_ENCRYPTION_KEY_BYTES } from '../env.js';
import {
  buildKeyring,
  DEFAULT_KEY_VERSION,
  DEV_KEY_DIR_NAME,
  DEV_KEY_FILE_NAME,
  getKeyring,
  keyFingerprint,
  resetKeyring,
} from './keys.js';

/**
 * The keyring's four rules (docs/plans/mvp/MVP-06.md §5), asserted against real files and a real env — but
 * never against `process.env` itself, which belongs to whoever started the test run.
 *
 * `devKeyDir` is the seam that makes the two dangerous rules testable: "the dev/test generated key lands
 * 0600 in `.dev/`" and "production never writes one" are both about a file, and a test must be able to look
 * somewhere other than this repository's own `.dev/`.
 */

function key(seed: number): Uint8Array {
  return new Uint8Array(
    Array.from({ length: NOTE_ENCRYPTION_KEY_BYTES }, (_, index) => (index + seed) % 253),
  );
}

const KEY_1_B64 = Buffer.from(key(1)).toString('base64');
const KEY_2_B64 = Buffer.from(key(2)).toString('base64');
const KEY_3_B64 = Buffer.from(key(3)).toString('base64');

/** Every log line `buildKeyring()` emitted, already parsed. */
interface LogLine {
  readonly level: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

function captureLogger(lines: LogLine[]): Logger {
  return pino({ level: 'trace' }, { write: (chunk: string) => lines.push(JSON.parse(chunk) as LogLine) });
}

function problemsOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).problems.join('\n');
  }
  throw new Error('expected buildKeyring() to throw EnvError, and it did not');
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'note-taker-keys-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetKeyring();
});

const devOnly = { NODE_ENV: 'test' } as const;

describe('the current key and its version', () => {
  it('defaults the version to 1 and takes the inline key', () => {
    const keyring = buildKeyring({
      source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: KEY_1_B64 },
      logger: captureLogger([]),
    });
    expect(keyring.current.version).toBe(DEFAULT_KEY_VERSION);
    expect(keyring.current.key).toEqual(key(1));
    expect(keyring.previous.size).toBe(0);
  });

  it('takes an explicit version verbatim', () => {
    const keyring = buildKeyring({
      source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: KEY_2_B64, NOTE_ENCRYPTION_KEY_VERSION: '7' },
      logger: captureLogger([]),
    });
    expect(keyring.current.version).toBe(7);
  });

  it('never derives the version from _PREVIOUS', () => {
    // The trap plan §10 names: deriving `max(previous)+1` collapses to 1 the moment the map is emptied,
    // and silently orphans every row tagged 2. So an unset version stays 1 no matter what is around it —
    // `max(previous)+1` would say 5 here, and the next day it would say 1.
    const keyring = buildKeyring({
      source: {
        NODE_ENV: 'test',
        NOTE_ENCRYPTION_KEY: KEY_3_B64,
        NOTE_ENCRYPTION_KEY_PREVIOUS: `{"3":${JSON.stringify(KEY_1_B64)},"4":${JSON.stringify(KEY_2_B64)}}`,
      },
      logger: captureLogger([]),
    });
    expect(keyring.current.version).toBe(DEFAULT_KEY_VERSION);
    expect([...keyring.previous.keys()].sort((a, b) => a - b)).toEqual([3, 4]);
    expect(keyring.previous.get(4)).toEqual(key(2));
  });

  it.each(['two', '0', '-3', '1.5', '99999999999999999999'])(
    'refuses the version %s and names the variable',
    (version) => {
      const problems = problemsOf(() =>
        buildKeyring({
          source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: KEY_1_B64, NOTE_ENCRYPTION_KEY_VERSION: version },
          logger: captureLogger([]),
        }),
      );
      expect(problems).toContain('NOTE_ENCRYPTION_KEY_VERSION');
    },
  );
});

describe('NOTE_ENCRYPTION_KEY / NOTE_ENCRYPTION_KEY_FILE', () => {
  it('reads a key out of a file, trailing newline and all', () => {
    const file = path.join(dir, 'note-key');
    writeFileSync(file, `${KEY_2_B64}\n`, { mode: 0o600 });

    const keyring = buildKeyring({
      source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY_FILE: file },
      logger: captureLogger([]),
    });
    expect(keyring.current.key).toEqual(key(2));
  });

  it('names the file when it cannot be read', () => {
    const missing = path.join(dir, 'nope');
    const problems = problemsOf(() =>
      buildKeyring({
        source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY_FILE: missing },
        logger: captureLogger([]),
      }),
    );
    expect(problems).toContain('NOTE_ENCRYPTION_KEY_FILE');
    expect(problems).toContain(missing);
    expect(problems).toContain('ENOENT');
  });

  it.each([
    ['31 bytes', Buffer.alloc(31, 7).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 7).toString('base64')],
    ['44 bytes', Buffer.alloc(44, 7).toString('base64')],
    ['16 bytes', Buffer.alloc(16, 4).toString('base64')],
  ])('refuses a key of %s in every mode and says it must be 32 bytes', (_label, value) => {
    // A truncated or padded key is a *different key*, so it must never be silently accepted: this is the
    // one place that stops "the database was written with another key" from looking like corruption. And
    // it holds in development too — the plan's rule is "32 bytes or refuse", not "32 bytes in production".
    for (const mode of ['development', 'test', 'production'] as const) {
      const problems = problemsOf(() =>
        buildKeyring({
          source: { NODE_ENV: mode, NOTE_ENCRYPTION_KEY: value },
          devKeyDir: path.join(dir, 'never'),
          logger: captureLogger([]),
        }),
      );
      expect(problems, `${mode}: ${problems}`).toContain('NOTE_ENCRYPTION_KEY');
      expect(problems, mode).toContain('must decode to exactly 32 bytes');
    }
  });

  it.each([
    ['a 43-character URL-safe key', '-'.repeat(43)],
    ['a key with a space in it', `${KEY_1_B64.slice(0, 20)} ${KEY_1_B64.slice(20)}`],
    ['a key with a header on it', `-----BEGIN KEY-----\n${KEY_1_B64}`],
  ])('refuses %s instead of decoding it into some other key', (_label, value) => {
    // Buffer.from(…, 'base64') discards anything outside the alphabet, which would turn a
    // copy-paste-mangled key into a shorter *valid-looking* one rather than an error.
    const problems = problemsOf(() =>
      buildKeyring({
        source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: value },
        devKeyDir: path.join(dir, 'never'),
        logger: captureLogger([]),
      }),
    );
    expect(problems).toContain('must be base64');
    expect(existsSync(path.join(dir, 'never'))).toBe(false);
  });

  it('does not fall back to a readable file when the inline key is broken', () => {
    const file = path.join(dir, 'note-key');
    writeFileSync(file, KEY_1_B64, { mode: 0o600 });

    const problems = problemsOf(() =>
      buildKeyring({
        source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: 'bm90LWEta2V5', NOTE_ENCRYPTION_KEY_FILE: file },
        logger: captureLogger([]),
      }),
    );
    expect(problems).toContain('NOTE_ENCRYPTION_KEY must decode to exactly 32 bytes');
  });
});

describe('NOTE_ENCRYPTION_KEY_PREVIOUS', () => {
  const withPrevious = (previous: string) =>
    buildKeyring({
      source: {
        NODE_ENV: 'test',
        NOTE_ENCRYPTION_KEY: KEY_2_B64,
        // A rotation: version 2 seals new rows and version 1 stays decrypt-only. The default version of 1
        // would make any `{"1": …}` entry shadow the current key, which is its own refusal below.
        NOTE_ENCRYPTION_KEY_VERSION: '2',
        NOTE_ENCRYPTION_KEY_PREVIOUS: previous,
      },
      logger: captureLogger([]),
    });

  it('parses the JSON map a rotation needs', () => {
    const keyring = withPrevious(`{"1":${JSON.stringify(KEY_1_B64)}}`);
    expect(keyring.previous.get(1)).toEqual(key(1));
  });

  it('treats an empty map as no previous keys, which is the normal state', () => {
    expect(withPrevious('{}').previous.size).toBe(0);
  });

  it.each([
    ['{not json', 'must be a JSON object'],
    ['[1,2]', 'must be a JSON object'],
    // The map's keys are *versions*: `{"<the base64 key>": …}` is the mistake this rules out, and it would
    // decrypt nothing rather than something. (That a previous entry may not shadow the current key is the
    // separate refusal below, because the current key is never in this map on purpose.)
    [`{"x":${JSON.stringify(KEY_1_B64)}}`, 'keys are key versions'],
    ['{"1":"not base64!!"}', 'must be base64'],
    [`{"1":${JSON.stringify(Buffer.alloc(16, 4).toString('base64'))}}`, 'must decode to exactly 32 bytes'],
  ])('reports %s rather than ignoring it', (previous, phrase) => {
    expect(problemsOf(() => withPrevious(previous))).toContain(phrase);
  });

  /**
   * These `problems` are logged — at boot and by `rotate-note-key.ts` — and V8's `JSON.parse` message quotes
   * the input around the failing position, so ~10 real key characters used to ride along (`{"1":CwwNDg8QER` is
   * what Node 22 printed for the first case below). Both inputs are the shell-mangling mistake the hint in the
   * message exists to prevent, so the leak was reachable by following the very footgun.
   */
  it.each([
    ['an unquoted value', `{"1":${KEY_1_B64}}`],
    ['a single-quoted inner value', `{"1":'${KEY_1_B64}"}`],
  ])('reports %s without repeating key material', (_mistake, previous) => {
    const problems = problemsOf(() => withPrevious(previous));
    expect(problems).toContain('must be a JSON object');
    // The parser's own sentence is what carried the snippet, so its absence is the assertion that matters; the
    // prefix is the belt to it — V8 truncates, so the whole key was never in one message anyway.
    expect(problems).not.toMatch(/Unexpected token|is not valid JSON/);
    expect(problems).not.toContain(KEY_1_B64.slice(0, 10));
  });

  it('describes a non-version entry key by shape, since an entry key can itself be a key', () => {
    // `{ "<the base64 key>": "<the base64 key>" }` parses happily and reaches the entry-key branch, which used
    // to quote the offending key verbatim — the same leak, one branch further down.
    const problems = problemsOf(() => withPrevious(JSON.stringify({ [KEY_1_B64]: KEY_1_B64 })));
    expect(problems).toContain('keys are key versions');
    expect(problems).not.toContain(KEY_1_B64.slice(0, 10));
  });

  it('refuses to shadow the current version', () => {
    // A key that both seals new rows and sits in the decrypt-only map makes `key_version` a lie about
    // which key wrote a row, which is the one thing the column exists for.
    const problems = problemsOf(() => withPrevious(`{"2":${JSON.stringify(KEY_1_B64)}}`));
    expect(problems).toContain('may not carry the current version (2)');
  });

  it('reports the version problem and the key problem in one pass', () => {
    const problems = problemsOf(() =>
      buildKeyring({
        source: {
          NODE_ENV: 'test',
          NOTE_ENCRYPTION_KEY: 'bm90LWEta2V5',
          NOTE_ENCRYPTION_KEY_PREVIOUS: '{not json',
        },
        logger: captureLogger([]),
      }),
    );
    expect(problems).toContain('NOTE_ENCRYPTION_KEY');
    expect(problems).toContain('NOTE_ENCRYPTION_KEY_PREVIOUS');
  });
});

describe('the generated development and test key', () => {
  it('creates .dev/note-key at 0600, reuses it, and logs the fingerprint it printed', () => {
    const lines: LogLine[] = [];
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    const options = { source: devOnly, logger: captureLogger(lines), devKeyDir };

    const first = buildKeyring(options);
    const file = path.join(devKeyDir, DEV_KEY_FILE_NAME);

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0o000); // group and world have no bits
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')).toHaveLength(NOTE_ENCRYPTION_KEY_BYTES);

    // The fingerprint in the log is the one that tells an operator whether this is the same key.
    const created = lines.find((line) => line.msg?.startsWith('generated the dev note-encryption key'));
    expect(created?.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(created?.keyFingerprint).toBe(keyFingerprint(first.current.key));

    const ready = lines.find((line) => line.msg === 'note encryption keyring ready');
    expect(ready).toBeDefined();
    expect(ready?.keyVersion).toBe(1);
    expect(ready?.keyFingerprint).toBe(keyFingerprint(first.current.key));
    expect(ready?.keySource).toBe('dev-key');

    const second = buildKeyring({ ...options, logger: captureLogger([]) });
    expect(second.current.key).toEqual(first.current.key);
    expect(lines.filter((line) => line.msg?.startsWith('generated the dev'))).toHaveLength(1);
  });

  it('creates the directory on demand, mode 0700, with no parent to pre-exist', () => {
    const devKeyDir = path.join(dir, 'fresh', DEV_KEY_DIR_NAME);
    expect(existsSync(devKeyDir)).toBe(false);
    buildKeyring({ source: { NODE_ENV: 'development' }, logger: captureLogger([]), devKeyDir });
    expect(existsSync(path.join(devKeyDir, DEV_KEY_FILE_NAME))).toBe(true);
    expect(statSync(devKeyDir).mode & 0o077).toBe(0o000);
  });

  it('tightens a key file that was created world-readable', () => {
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    mkdirSync(devKeyDir, { mode: 0o755 });
    const file = path.join(devKeyDir, DEV_KEY_FILE_NAME);
    // chmod, not `writeFileSync({mode})`: the process umask can take bits *away* from a create mode, so
    // only chmod proves the file really started out readable by someone other than its owner.
    writeFileSync(file, `${KEY_1_B64}\n`);
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o077).not.toBe(0o000);

    const keyring = buildKeyring({ source: devOnly, logger: captureLogger([]), devKeyDir });
    expect(keyring.current.key).toEqual(key(1));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a corrupt dev key file and says what deleting it costs', () => {
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    mkdirSync(devKeyDir);
    const file = path.join(devKeyDir, DEV_KEY_FILE_NAME);
    writeFileSync(file, 'not a key\n');

    const problems = problemsOf(() =>
      buildKeyring({ source: devOnly, logger: captureLogger([]), devKeyDir }),
    );
    expect(problems).toContain(DEV_KEY_FILE_NAME);
    expect(problems).toContain(`Delete ${file}`);
    expect(problems).toContain('unreadable');
  });

  it('generates a different key once the file is gone, which is the documented caveat', () => {
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    const options = { source: devOnly, logger: captureLogger([]), devKeyDir };
    const before = buildKeyring(options);
    rmSync(path.join(devKeyDir, DEV_KEY_FILE_NAME));

    const after = buildKeyring(options);
    expect(after.current.key).not.toEqual(before.current.key);
  });
});

describe('production refuses to boot without a key', () => {
  it('names the variables it needs and writes no key file anywhere', () => {
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    const problems = problemsOf(() =>
      buildKeyring({ source: { NODE_ENV: 'production' }, logger: captureLogger([]), devKeyDir }),
    );

    expect(problems).toContain('NOTE_ENCRYPTION_KEY');
    expect(problems).toContain('NOTE_ENCRYPTION_KEY_FILE');
    expect(problems).toContain('refuses to boot');
    // The rule that makes this the only safe default: nothing was written, so nothing was encrypted.
    expect(existsSync(devKeyDir)).toBe(false);
  });

  it('still refuses when a broken key is the only thing configured', () => {
    const devKeyDir = path.join(dir, DEV_KEY_DIR_NAME);
    const problems = problemsOf(() =>
      buildKeyring({
        source: { NODE_ENV: 'production', NOTE_ENCRYPTION_KEY: 'bm90LWEta2V5' },
        logger: captureLogger([]),
        devKeyDir,
      }),
    );
    expect(problems).toContain('must decode to exactly 32 bytes');
    expect(existsSync(devKeyDir)).toBe(false);
  });

  it('boots with a real key, and that is the whole difference', () => {
    const keyring = buildKeyring({
      source: { NODE_ENV: 'production', NOTE_ENCRYPTION_KEY: KEY_1_B64, NOTE_ENCRYPTION_KEY_VERSION: '2' },
      logger: captureLogger([]),
      devKeyDir: path.join(dir, DEV_KEY_DIR_NAME),
    });
    expect(keyring.current).toEqual({ version: 2, key: key(1) });
    expect(existsSync(path.join(dir, DEV_KEY_DIR_NAME))).toBe(false);
  });
});

describe('getKeyring()', () => {
  it('boots one keyring for the whole process, and logs one fingerprint', () => {
    const lines: LogLine[] = [];
    const options = {
      source: devOnly,
      logger: captureLogger(lines),
      devKeyDir: path.join(dir, DEV_KEY_DIR_NAME),
    };

    const first = getKeyring(options);
    const second = getKeyring({ source: { NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: KEY_1_B64 } });
    expect(second).toBe(first);
    expect(lines.filter((line) => line.msg === 'note encryption keyring ready')).toHaveLength(1);

    resetKeyring();
    const third = getKeyring({ ...options, logger: captureLogger([]) });
    expect(third).not.toBe(first);
    expect(third.current.key).toEqual(first.current.key);
  });
});
