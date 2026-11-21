import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  databaseUrl,
  decodeNoteEncryptionKey,
  dotenvPath,
  EnvError,
  LOG_LEVEL_VALUES,
  loadDevEnvFile,
  NODE_ENV_VALUES,
  NOTE_ENCRYPTION_KEY_BYTES,
  nodeEnvOf,
  noteEncryptionKeyBytes,
  parseEnv,
  readNoteEncryptionKey,
  repoRoot,
  resetDatabaseUrlWarning,
} from './env.js';

/**
 * `loadDevEnvFile()` writes into `process.env`, so every loader test has to undo exactly what it
 * touched. `undefined` in the patch means "assert this starts out unset and clean it afterwards",
 * which is also how the fixture's keys get rolled back.
 */
function withEnv<T>(patch: Record<string, string | undefined>, body: () => T): T {
  const before = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) before.set(key, process.env[key]);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `body`, asserts it failed with an {@link EnvError}, and hands back the problems. */
function problemsOf(body: () => unknown): readonly string[] {
  let thrown: unknown;
  try {
    body();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof EnvError)) {
    throw new Error(`expected an EnvError to be thrown, got ${String(thrown)}`);
  }
  return thrown.problems;
}

/** The whole point of the guard: the message has to name the variable a human can go and set. */
function expectProblemAbout(body: () => unknown, variable: string): string {
  const problems = problemsOf(body);
  const joined = problems.join('\n');
  expect(joined, `expected a problem naming ${variable}, got:\n${joined}`).toContain(variable);
  return joined;
}

/** A well-formed AES-256 key, for the fixtures that only need *a* key and not a particular one. */
const THIRTY_TWO_BYTES_B64 = Buffer.alloc(NOTE_ENCRYPTION_KEY_BYTES, 7).toString('base64');

beforeEach(() => {
  // The DATABASE_URL/POSTGRES_* disagreement warning is latched once per process (plan §16), so
  // every test starts with the latch open.
  resetDatabaseUrlWarning();
});

describe('parseEnv() — NODE_ENV is required, in every environment, with no default', () => {
  // Each branch looks like a normal configuration for one mode except for the one variable that
  // decides which invariants apply. Nothing may rescue it: not a default, not the other keys.
  const branches = [
    { name: 'development-shaped', source: { HOST: '127.0.0.1', PORT: '3001' } },
    { name: 'test-shaped', source: { DATABASE_URL: 'postgres://x:y@localhost:5432/x', LOG_LEVEL: 'debug' } },
    {
      name: 'production-shaped',
      source: { DATABASE_URL: 'postgres://x:y@db.internal:5432/x', SECURE_COOKIES: 'true' },
    },
    { name: 'nothing set at all', source: {} },
  ] as const;

  it.each(branches)('fails with a readable missing-variable message ($name)', ({ source }) => {
    const message = expectProblemAbout(() => parseEnv(source), 'NODE_ENV');
    expect(message).toContain('required');
    // The message has to be actionable: a reader must not need to open env.ts to fix it.
    for (const value of NODE_ENV_VALUES) expect(message).toContain(value);
  });

  it('treats an empty NODE_ENV as unset rather than as a mode', () => {
    expectProblemAbout(() => parseEnv({ NODE_ENV: '   ' }), 'NODE_ENV');
  });

  it('rejects an unrecognised NODE_ENV instead of guessing a mode', () => {
    expectProblemAbout(() => parseEnv({ NODE_ENV: 'staging' }), 'NODE_ENV');
    expectProblemAbout(() => parseEnv({ NODE_ENV: 'Development' }), 'NODE_ENV');
  });

  it.each(NODE_ENV_VALUES)('accepts %s', (nodeEnv) => {
    // PR-06 armed one more production invariant, so the fixture has to be a *complete* production
    // configuration: `production` no longer boots from `NODE_ENV` alone, which is exactly the point.
    expect(parseEnv({ NODE_ENV: nodeEnv, NOTE_ENCRYPTION_KEY: THIRTY_TWO_BYTES_B64 }).NODE_ENV).toBe(nodeEnv);
  });

  it('nodeEnvOf() reports the mode without deciding whether one is required', () => {
    // `crypto/keys.ts` needs to know which mode it is in before anything is allowed to throw, and
    // `loadDevEnvFile()`/`databaseUrl()` already read the same value: one function, three callers (plan §16).
    for (const nodeEnv of NODE_ENV_VALUES) expect(nodeEnvOf({ NODE_ENV: nodeEnv })).toBe(nodeEnv);
    expect(nodeEnvOf({ NODE_ENV: ' production ' })).toBe('production');
    expect(nodeEnvOf({ NODE_ENV: 'staging' })).toBeUndefined();
    expect(nodeEnvOf({})).toBeUndefined();
  });
});

describe('parseEnv() — documented defaults (plan §16)', () => {
  it('applies every default when only NODE_ENV is set', () => {
    expect(parseEnv({ NODE_ENV: 'test' })).toEqual({
      NODE_ENV: 'test',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DB_POOL_MAX: 10,
      SESSION_TTL_DAYS: 30,
      SECURE_COOKIES: false,
      TRUST_PROXY: false,
      ALLOW_REGISTRATION: false,
      LOGIN_RATE_LIMIT_MAX: 10,
      MAX_NOTE_BYTES: 1048576,
      APP_NAME: 'Note Taker',
      // PR-06: the version `crypto/envelope.ts` stamps into `notes.key_version`. A variable of its own,
      // never derived from `NOTE_ENCRYPTION_KEY_PREVIOUS` — see the comment on `ENV_DEFAULTS`.
      NOTE_ENCRYPTION_KEY_VERSION: 1,
    });
  });

  it('coerces the typed values a host process actually needs', () => {
    const env = parseEnv({
      NODE_ENV: 'development',
      PORT: '8080',
      SECURE_COOKIES: 'TRUE',
      TRUST_PROXY: '1',
      ALLOW_REGISTRATION: 'false',
      LOG_LEVEL: 'debug',
      APP_NAME: 'My Notes',
    });
    expect(env).toMatchObject({
      PORT: 8080,
      SECURE_COOKIES: true,
      TRUST_PROXY: true,
      ALLOW_REGISTRATION: false,
      LOG_LEVEL: 'debug',
      APP_NAME: 'My Notes',
    });
  });

  it('ignores the rest of the process environment (PATH and friends are not configuration)', () => {
    const env = parseEnv({ NODE_ENV: 'test', PATH: '/usr/bin', HOME: '/root', SHLVL: '2' });
    expect(env).not.toHaveProperty('PATH');
  });
});

describe('parseEnv() — unknown values are refused, and reported together', () => {
  it('names every broken variable in one pass', () => {
    const problems = problemsOf(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: '3000; rm -rf /',
        LOG_LEVEL: 'verbose',
        SECURE_COOKIES: 'maybe',
        SESSION_TTL_DAYS: '0',
      }),
    );
    const joined = problems.join('\n');
    for (const variable of ['PORT', 'LOG_LEVEL', 'SECURE_COOKIES', 'SESSION_TTL_DAYS']) {
      expect(joined, `expected a problem naming ${variable}, got:\n${joined}`).toContain(variable);
    }
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it.each(LOG_LEVEL_VALUES)('accepts the pino level %s', (level) => {
    expect(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
  });
});

describe('parseEnv() — production invariants encoded in PR-01', () => {
  it('refuses a session that outlives a year', () => {
    expectProblemAbout(
      () => parseEnv({ NODE_ENV: 'production', SECURE_COOKIES: 'true', SESSION_TTL_DAYS: '400' }),
      'SESSION_TTL_DAYS',
    );
  });

  it('refuses insecure cookies behind a proxy', () => {
    expectProblemAbout(
      () => parseEnv({ NODE_ENV: 'production', SECURE_COOKIES: 'false', TRUST_PROXY: 'true' }),
      'SECURE_COOKIES',
    );
  });

  it('refuses open registration over plain HTTP', () => {
    const message = expectProblemAbout(
      () => parseEnv({ NODE_ENV: 'production', ALLOW_REGISTRATION: 'true', SECURE_COOKIES: 'false' }),
      'ALLOW_REGISTRATION',
    );
    expect(message).toContain('SECURE_COOKIES');
  });

  it('leaves the same three settings alone outside production, where the local stack is plain HTTP', () => {
    const env = parseEnv({
      NODE_ENV: 'development',
      SESSION_TTL_DAYS: '400',
      TRUST_PROXY: 'true',
      ALLOW_REGISTRATION: 'true',
      SECURE_COOKIES: 'false',
    });
    expect(env).toMatchObject({
      SESSION_TTL_DAYS: 400,
      TRUST_PROXY: true,
      ALLOW_REGISTRATION: true,
      SECURE_COOKIES: false,
    });
  });
});

describe('loadDevEnvFile() + dotenvPath()', () => {
  let tempDir = '';

  const writeFixture = (name: string, contents: string): string => {
    const file = path.join(tempDir, name);
    writeFileSync(file, contents, 'utf8');
    return file;
  };

  /**
   * Node 22's env-file parser is lenient about *content* (a line without `=`, invalid UTF-8 and
   * unterminated quotes are all tolerated), so the only loud failures it produces are read
   * failures. A directory is the deterministic one, and it is exactly the case the ENOENT-only
   * `catch` must not swallow.
   */
  const unreadableFixture = (): string => {
    const directory = path.join(tempDir, 'not-a-file.env');
    mkdirSync(directory, { recursive: true });
    return directory;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'note-taker-env-'));
    resetDatabaseUrlWarning();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fills in values the process environment does not have', () => {
    const file = writeFixture('app.env', 'HOST=10.0.0.5\nPORT=3999\nLOG_LEVEL=debug\n');
    withEnv(
      { NODE_ENV: 'development', DOTENV_PATH: file, HOST: undefined, PORT: undefined, LOG_LEVEL: undefined },
      () => {
        loadDevEnvFile();
        expect(process.env.HOST).toBe('10.0.0.5');
        expect(process.env.PORT).toBe('3999');
        expect(process.env.LOG_LEVEL).toBe('debug');
        expect(parseEnv().PORT).toBe(3999);
      },
    );
  });

  it('lets the environment beat the file, while still filling the gaps', () => {
    const file = writeFixture('app.env', 'HOST=10.0.0.5\nPORT=3999\n');
    withEnv({ NODE_ENV: 'development', DOTENV_PATH: file, HOST: 'from-process', PORT: undefined }, () => {
      loadDevEnvFile();
      expect(process.env.HOST).toBe('from-process');
      expect(process.env.PORT).toBe('3999');
    });
  });

  it('is a silent no-op when the file does not exist (a bare clone has none)', () => {
    const missing = path.join(tempDir, 'absent.env');
    withEnv({ NODE_ENV: 'test', DOTENV_PATH: missing, HOST: undefined, PORT: undefined }, () => {
      expect(() => loadDevEnvFile()).not.toThrow();
      expect(process.env.HOST).toBeUndefined();
      expect(() => parseEnv()).not.toThrow();
    });
  });

  it('fails loudly on any read failure that is not ENOENT', () => {
    const directory = unreadableFixture();
    withEnv({ NODE_ENV: 'development', DOTENV_PATH: directory }, () => {
      const message = expectProblemAbout(() => loadDevEnvFile(), 'DOTENV_PATH');
      expect(message).toContain('not-a-file.env');
    });
  });

  it('never opens the file when the process is in production mode', () => {
    const directory = unreadableFixture();
    // An unreadable file would throw if it were opened: reaching the assertion proves it was not.
    withEnv({ NODE_ENV: 'production', DOTENV_PATH: directory }, () => {
      expect(() => loadDevEnvFile()).not.toThrow();
    });

    const file = writeFixture('app.env', 'HOST=10.0.0.5\nPORT=3999\n');
    withEnv({ NODE_ENV: 'production', DOTENV_PATH: file, HOST: undefined, PORT: undefined }, () => {
      loadDevEnvFile();
      expect(process.env.HOST).toBeUndefined();
      expect(process.env.PORT).toBeUndefined();
    });
  });

  it('anchors the default path at the workspace root, not at apps/', () => {
    const root = repoRoot();
    expect(existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(true);
    // Walking up from the source directory must land on the repo root. The naive
    // `../../.env` from apps/server/src/ lands on apps/.env instead, and the depth changes again
    // once this file is compiled into apps/server/dist/.
    expect(repoRoot(path.join(root, 'apps', 'server', 'src'))).toBe(root);
    expect(repoRoot(path.join(root, 'apps', 'server', 'src'))).not.toBe(path.join(root, 'apps'));
    expect(dotenvPath({})).toBe(path.join(root, '.env'));
  });

  it('walks up to the first pnpm-workspace.yaml in an arbitrary tree', () => {
    const nested = path.join(tempDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(tempDir, 'a', 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
    expect(repoRoot(nested)).toBe(path.join(tempDir, 'a'));
    expect(dotenvPath({}, nested)).toBe(path.join(tempDir, 'a', '.env'));
  });

  it('fails naming the marker file it could not find', () => {
    const lonely = path.join(tempDir, 'lonely');
    mkdirSync(lonely, { recursive: true });
    expectProblemAbout(() => dotenvPath({}, lonely), 'pnpm-workspace.yaml');
  });

  it('prefers DOTENV_PATH over the derived path', () => {
    const file = path.join(tempDir, 'elsewhere.env');
    withEnv({ NODE_ENV: 'development', DOTENV_PATH: file }, () => {
      expect(dotenvPath()).toBe(file);
    });
  });
});

describe('databaseUrl() — the single DSN resolver, no DB involved', () => {
  it('uses an explicit DATABASE_URL verbatim, reserved characters and all', () => {
    const literal = 'postgres://app:p%40ssw0rd@db.internal:6432/notes?sslmode=require';
    expect(databaseUrl({ NODE_ENV: 'production', DATABASE_URL: literal })).toBe(literal);
    // Not a template: nothing expands ${...} on the way, so a hand-written DSN is a literal.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder IS the thing under test.
    const raw = 'postgres://app:${POSTGRES_PASSWORD}@db/notes';
    expect(databaseUrl({ NODE_ENV: 'production', DATABASE_URL: raw })).toBe(raw);
  });

  it('derives the documented dev DSN when nothing is set', () => {
    expect(databaseUrl({ NODE_ENV: 'development' })).toBe(
      'postgres://notetaker:notetaker@localhost:5432/notetaker',
    );
    expect(databaseUrl({ NODE_ENV: 'test' })).toBe('postgres://notetaker:notetaker@localhost:5432/notetaker');
  });

  it('composes every POSTGRES_* value, so editing POSTGRES_PORT moves every host tool', () => {
    expect(databaseUrl({ NODE_ENV: 'development', POSTGRES_PORT: '5433' })).toBe(
      'postgres://notetaker:notetaker@localhost:5433/notetaker',
    );
    expect(
      databaseUrl({
        NODE_ENV: 'test',
        POSTGRES_USER: 'owner',
        POSTGRES_PASSWORD: 'hexdead',
        POSTGRES_DB: 'notesdb',
      }),
    ).toBe('postgres://owner:hexdead@localhost:5432/notesdb');
  });

  it('fails as a missing required var in production, naming DATABASE_URL', () => {
    const message = expectProblemAbout(() => databaseUrl({ NODE_ENV: 'production' }), 'DATABASE_URL');
    expect(message).toContain('production');
  });

  it('refuses to derive without a mode', () => {
    expectProblemAbout(() => databaseUrl({ POSTGRES_PORT: '5433' }), 'NODE_ENV');
    expectProblemAbout(() => databaseUrl({ NODE_ENV: 'staging' }), 'NODE_ENV');
  });

  it('refuses a POSTGRES_* value that would mangle the DSN, naming the variable', () => {
    for (const reserved of ['@', ':', '/', '+', '%', '?', '#']) {
      for (const variable of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'] as const) {
        const message = expectProblemAbout(
          () => databaseUrl({ NODE_ENV: 'development', [variable]: `no${reserved}good` }),
          variable,
        );
        expect(message).toContain('[A-Za-z0-9]+');
      }
    }

    // Deliberately stricter than "reserved characters only": `_` is refused as well. The alternative
    // is a percent-encoder quietly rewriting a credential (plan §16), and a name outside the safe
    // set has an escape hatch — set DATABASE_URL verbatim.
    expectProblemAbout(
      () => databaseUrl({ NODE_ENV: 'development', POSTGRES_DB: 'note_taker' }),
      'POSTGRES_DB',
    );
  });

  it('refuses a POSTGRES_PORT that is not a port', () => {
    expectProblemAbout(
      () => databaseUrl({ NODE_ENV: 'development', POSTGRES_PORT: 'not-a-port' }),
      'POSTGRES_PORT',
    );
    expectProblemAbout(() => databaseUrl({ NODE_ENV: 'test', POSTGRES_PORT: '70000' }), 'POSTGRES_PORT');
  });

  it('warns once, naming both sides, when a literal DSN disagrees with POSTGRES_* in dev/test', () => {
    const warn = vi.fn();
    const source = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5433/other_db',
      POSTGRES_PORT: '5432',
      POSTGRES_DB: 'notetaker',
    } as const;

    expect(databaseUrl(source, { warn })).toBe(source.DATABASE_URL);
    expect(databaseUrl(source, { warn })).toBe(source.DATABASE_URL);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('POSTGRES_PORT=5432');
    expect(message).toContain('POSTGRES_DB=notetaker');
  });

  it('stays quiet when the DSN and POSTGRES_* agree, and in production', () => {
    const warn = vi.fn();
    databaseUrl(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://u:p@localhost:5432/notetaker',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'notetaker',
      },
      { warn },
    );
    databaseUrl(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@other:1/zzz',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'notetaker',
      },
      { warn },
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the note-encryption key material (PR-06)', () => {
  // The shape rules live here rather than in `crypto/keys.ts` because the production boot guard below and
  // the keyring builder have to apply the same one — two implementations of "did the operator hand us 32
  // bytes" drift the first time one of them is fixed.
  const key = (seed: number): string =>
    Buffer.from(Uint8Array.from({ length: NOTE_ENCRYPTION_KEY_BYTES }, (_, index) => index + seed)).toString(
      'base64',
    );

  /** Valid base64, wrong length: the shape a key that was truncated in transit has. */
  const SHORT_B64 = Buffer.alloc(31, 3).toString('base64');

  const keyFile = (contents: string): string => {
    const file = path.join(tempKeyDir, 'mounted-key');
    writeFileSync(file, contents, 'utf8');
    return file;
  };

  let tempKeyDir = '';

  beforeEach(() => {
    tempKeyDir = mkdtempSync(path.join(tmpdir(), 'note-taker-env-key-'));
  });

  afterEach(() => {
    rmSync(tempKeyDir, { recursive: true, force: true });
  });

  it('reads the inline key, and reports which variable it came from', () => {
    const reading = readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY: `${key(4)}\n` });
    expect(reading.configured).toBe(true);
    expect(reading.problems).toEqual([]);
    expect(reading.from).toBe('NOTE_ENCRYPTION_KEY');
    // The trailing newline is tolerated: `echo > file` and a text editor both leave one behind.
    expect(reading.key).toEqual(
      Uint8Array.from({ length: NOTE_ENCRYPTION_KEY_BYTES }, (_, index) => index + 4),
    );
  });

  it('reads a key out of the mounted file when the inline one is not set', () => {
    const file = keyFile(`${key(9)}\n`);
    const reading = readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY_FILE: ` ${file} ` });
    expect(reading.from).toBe('NOTE_ENCRYPTION_KEY_FILE');
    expect(reading.key).toEqual(
      Uint8Array.from({ length: NOTE_ENCRYPTION_KEY_BYTES }, (_, index) => index + 9),
    );
  });

  it('does not treat a readable file as a fallback for a broken inline key', () => {
    const file = keyFile(key(9));
    const reading = readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY: SHORT_B64, NOTE_ENCRYPTION_KEY_FILE: file });
    expect(reading.key).toBeUndefined();
    expect(reading.configured).toBe(true);
    expect(reading.problems.join('\n')).toContain('NOTE_ENCRYPTION_KEY must decode to exactly 32 bytes');
  });

  it('says the file is unreadable rather than falling back to nothing', () => {
    const missing = path.join(tempKeyDir, 'not-mounted');
    const reading = readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY_FILE: missing });
    expect(reading.problems.join('\n')).toContain(missing);
    expect(reading.problems.join('\n')).toContain('ENOENT');
  });

  it.each([
    ['a 31-byte key', Buffer.alloc(31, 3).toString('base64')],
    ['a 44-byte key', Buffer.alloc(44, 3).toString('base64')],
    ['a URL-safe 43-character key', '-'.repeat(43)],
  ])('refuses %s with a message naming the variable', (_label, value) => {
    const reading = readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY: value });
    expect(reading.key).toBeUndefined();
    expect(reading.configured).toBe(true);
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]).toContain('NOTE_ENCRYPTION_KEY');
  });

  it('calls "nothing configured" a different state from a broken key', () => {
    // `crypto/keys.ts` may generate a key when nothing is set (development and test only); it must never
    // do that when something *was* set and merely failed to parse.
    const nothing = readNoteEncryptionKey({ NODE_ENV: 'test' });
    expect(nothing).toEqual({ problems: [], configured: false });

    const broken = readNoteEncryptionKey({ NODE_ENV: 'test', NOTE_ENCRYPTION_KEY: SHORT_B64 });
    expect(broken.configured).toBe(true);
  });

  it('an empty value is unset, so it cannot smuggle an empty key into a keyring', () => {
    expect(readNoteEncryptionKey({ NOTE_ENCRYPTION_KEY: '   ' })).toEqual({
      problems: [],
      configured: false,
    });
  });

  it('noteEncryptionKeyBytes() is the version that refuses to continue', () => {
    expect(noteEncryptionKeyBytes({ NOTE_ENCRYPTION_KEY: key(4) })).toHaveLength(NOTE_ENCRYPTION_KEY_BYTES);
    const message = expectProblemAbout(
      () => noteEncryptionKeyBytes({ NODE_ENV: 'production' }),
      'NOTE_ENCRYPTION_KEY',
    );
    expect(message).toContain('NOTE_ENCRYPTION_KEY_FILE');
    // The sentence has to say what is being refused, not just what is missing (plan §10: no plaintext mode).
    expect(message).toContain('no plaintext mode');
  });

  it('decodeNoteEncryptionKey() labels the variable it was given', () => {
    const entry = 'NOTE_ENCRYPTION_KEY_PREVIOUS["1"]';
    const decoded = decodeNoteEncryptionKey(SHORT_B64, entry);
    // A bad entry inside the map has to name *itself*, or an operator with four previous keys is left
    // guessing which one to re-generate.
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.problem).toContain(entry);
    expect(decodeNoteEncryptionKey(key(4)).ok).toBe(true);
  });

  it('parses the key version as its own variable', () => {
    expect(parseEnv({ NODE_ENV: 'test', NOTE_ENCRYPTION_KEY_VERSION: '3' }).NOTE_ENCRYPTION_KEY_VERSION).toBe(
      3,
    );
    expectProblemAbout(
      () => parseEnv({ NODE_ENV: 'test', NOTE_ENCRYPTION_KEY_VERSION: 'v1' }),
      'NOTE_ENCRYPTION_KEY_VERSION',
    );
    expectProblemAbout(
      () => parseEnv({ NODE_ENV: 'test', NOTE_ENCRYPTION_KEY_VERSION: '0' }),
      'NOTE_ENCRYPTION_KEY_VERSION',
    );
  });

  describe('the production boot guard', () => {
    const inProduction = (source: Record<string, string>) => parseEnv({ NODE_ENV: 'production', ...source });

    it('refuses to boot a production process with no key', () => {
      const message = expectProblemAbout(() => inProduction({}), 'NOTE_ENCRYPTION_KEY');
      expect(message).toContain('refuses to boot');
    });

    it('refuses a production process whose key is not 32 bytes', () => {
      expectProblemAbout(() => inProduction({ NOTE_ENCRYPTION_KEY: SHORT_B64 }), 'NOTE_ENCRYPTION_KEY');
    });

    it('boots with a valid inline key, and with one mounted from a file', () => {
      expect(inProduction({ NOTE_ENCRYPTION_KEY: key(4) }).NOTE_ENCRYPTION_KEY_VERSION).toBe(1);
      expect(inProduction({ NOTE_ENCRYPTION_KEY_FILE: keyFile(key(4)) }).NODE_ENV).toBe('production');
    });

    it('reports the key problem beside the other production problems, in one pass', () => {
      const message = expectProblemAbout(
        () => inProduction({ SECURE_COOKIES: 'false', TRUST_PROXY: 'true', NOTE_ENCRYPTION_KEY: SHORT_B64 }),
        'SECURE_COOKIES',
      );
      expect(message).toContain('NOTE_ENCRYPTION_KEY');
    });

    it.each(['development', 'test'] as const)(
      'lets %s boot without a key, where crypto/keys.ts generates one instead',
      (nodeEnv) => {
        // The guard is deliberately production-only: refusing in development would break the documented
        // first-run experience, and generating silently in production is the failure plan §10 refuses.
        expect(parseEnv({ NODE_ENV: nodeEnv }).NOTE_ENCRYPTION_KEY_VERSION).toBe(1);
      },
    );
  });
});
