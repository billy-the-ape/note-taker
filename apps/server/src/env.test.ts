import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  databaseUrl,
  dotenvPath,
  EnvError,
  LOG_LEVEL_VALUES,
  loadDevEnvFile,
  NODE_ENV_VALUES,
  parseEnv,
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
    expect(parseEnv({ NODE_ENV: nodeEnv }).NODE_ENV).toBe(nodeEnv);
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
