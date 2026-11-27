/**
 * The e2e harness's configuration (docs/plans/mvp/MVP-19.md §4) — the one place the Playwright suite decides
 * where the app it drives lives and what database it is pointed at.
 *
 * **Why this file exists next to `env.ts` on the server rather than reusing it.** `apps/server/src/env.ts` is
 * the *boot guard*: it parses a process's environment and refuses to start a broken instance. This file is the
 * mirror image — it is the environment **writer**: it decides what the compiled server is handed, and it must
 * say the same words as the specs and `e2e/db.ts` do, so the three cannot disagree about which DSN or which key
 * the suite is talking about. It deliberately does not import the server's module: pnpm does not expose one
 * workspace's dependencies to another (AGENTS.md), and importing a boot guard into a test harness invites the
 * harness to start defaulting things the guard exists to refuse.
 *
 * **Three sources, in a fixed order: process env → repo-root `.env.test` → the constants below.** Process env
 * wins because that is how CI supplies both values (the `e2e` job's `env:` block, PR-19 §4), and because a
 * developer running one spec against an odd port should not have to edit a file. `.env.test` is the local
 * route, gitignored (`.env.*` in `.gitignore`, with `.env.example` the only whitelisted name) and never read by
 * any shipped process: `apps/server`'s `loadDevEnvFile()` reads `.env`, not `.env.test`, so a deployed
 * container cannot pick up a test value even by accident. The constants are last, and they are throwaway
 * defaults — the DSN of a locally-running Postgres with the dev credentials, and a note-encryption key that
 * protects nothing and is written into this repository on purpose.
 *
 * **The key is a non-secret constant, and that is a decision rather than an oversight** (PR-19 §4): the suite
 * encrypts a throwaway database that is dropped between runs with a key whose only purpose is to make
 * `key_version` and the ciphertext observable. It must never be reused outside the suite, and it is the value
 * the CI job also exports, so "the same throwaway value in CI and locally" is checkable rather than hoped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/web` — the package that owns this suite, and the directory Playwright resolves `testDir` against. */
export const WEB_ROOT = resolve(here, '..');
/** The repository root, which is where `.env.test` lives and where the compiled server expects to be run from. */
export const REPO_ROOT = resolve(WEB_ROOT, '..', '..');

/**
 * 32 base64 bytes — `AES-256-GCM` wants a 256-bit key (plan §8), and `env.ts` refuses anything else. The
 * plaintext behind it is the ASCII sentence `'note-taker e2e throwaway key 012'`.
 */
export const TEST_NOTE_ENCRYPTION_KEY = 'bm90ZS10YWtlciBlMmUgdGhyb3dhd2F5IGtleSAwMTI=';

/**
 * The default DSN: the dev trio from `.env.example` (`notetaker` / `notetaker`) against a **separate
 * database**, `notetaker_test`, so a suite run cannot truncate somebody's hand-made dev tree out of the same
 * cluster. CI overrides it with the `postgres:16` service's own credentials, exactly as the `integration` job
 * does (`.github/workflows/CI.yml`).
 */
export const TEST_DATABASE_URL = 'postgres://notetaker:notetaker@127.0.0.1:5432/notetaker_test';

/** Bound on loopback only: the suite never needs a reachable port, and a reachable port is a shared instance. */
export const API_HOST = '127.0.0.1';
/**
 * Not `3000`. `pnpm dev` runs the API there on the same machine, and `reuseExistingServer` must mean "the
 * server I already started for this suite", not "somebody's Vite-era API with a different database".
 * `E2E_PORT` moves it, and the browser follows because {@link BASE_URL} is derived from it.
 */
export const API_PORT = process.env.E2E_PORT ?? '3100';

/** What the browser is pointed at. The SPA and the API are one origin (PR-12's `static-spa`), so `/api` works. */
export const BASE_URL = `http://${API_HOST}:${API_PORT}`;

/** The health path the `webServer` readiness probe polls — the same one PR-18's `HEALTHCHECK` uses. */
export const READY_URL = `${BASE_URL}/api/healthz`;

/** The file a contributor writes once on a machine whose Postgres is not the default one, and never commits. */
export const ENV_TEST_PATH = join(REPO_ROOT, '.env.test');

/**
 * Parses `KEY=value` lines. Deliberately not a `dotenv` dependency: the suite needs four lines of parsing, and
 * `process.loadEnvFile` (which the app uses) cannot read a file other than `.env` without mutating
 * `process.env` — which would then leak into every other Vitest/Vite process a developer runs next.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/u, '$2');
    if (key !== '') parsed[key] = value;
  }
  return parsed;
}

/** `.env.test` if it exists, `{}` otherwise — a missing file is the normal state, not an error. */
function envTestFile(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const path = source.DOTENV_TEST_PATH ?? ENV_TEST_PATH;
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, 'utf8'));
}

/** One setting, in the documented order: real environment, then `.env.test`, then the suite's own default. */
function setting(name: string, fallback: string, file: Record<string, string>): string {
  return process.env[name] ?? file[name] ?? fallback;
}

const file = envTestFile();

/** The database the suite owns. `e2e/reset.ts` empties it, `e2e/db.ts` reads it, the server writes it. */
export const DATABASE_URL = setting('DATABASE_URL', TEST_DATABASE_URL, file);
/** The throwaway key. Same value in CI, same value on a laptop, so a red run means the same thing in both. */
export const NOTE_ENCRYPTION_KEY = setting('NOTE_ENCRYPTION_KEY', TEST_NOTE_ENCRYPTION_KEY, file);
/**
 * The version every new `notes.key_version` carries (PR-06). Scenario 7 asserts the row against **this** value
 * rather than against `1`, so a run with `NOTE_ENCRYPTION_KEY_VERSION=2` still asserts something.
 */
export const NOTE_ENCRYPTION_KEY_VERSION = setting('NOTE_ENCRYPTION_KEY_VERSION', '1', file);

/**
 * The environment the compiled API is booted with, by `playwright.config.ts`'s `webServer`.
 *
 * `NODE_ENV` is here explicitly (PR-19 §4: an inherited unset value dies on the boot guard before any spec
 * runs), and so is every value the specs assert on. Three of them are not defaults a production host would
 * choose, each for one reason the suite cannot do without:
 *
 * * `ALLOW_REGISTRATION` — the four spec files need separate accounts, because one user is one tree and a
 *   tree shared between files makes "the tree is empty" unassertable. `POST /api/auth/register` is the only
 *   door a member can come through, and it needs an owner to already exist — which is why `auth.spec.ts` is
 *   the file that walks `/setup`.
 * * `LOGIN_RATE_LIMIT_MAX` — plan §10's window is 10 per 15 minutes per username+address. The suite logs in
 *   repeatedly from one address in one window, and `POST /api/auth/register` shares the window
 *   (`registerRateLimitKey`); a 500 that arrived mid-suite would be a rate limit nobody can read in a
 *   screenshot.
 * * `SECURE_COOKIES=false` — the suite is plain HTTP on loopback, and `env.ts` refuses the combination only in
 *   production, which is the mode this is not.
 */
export function serverEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    HOST: API_HOST,
    PORT: API_PORT,
    DATABASE_URL,
    NOTE_ENCRYPTION_KEY,
    NOTE_ENCRYPTION_KEY_VERSION,
    ALLOW_REGISTRATION: 'true',
    LOGIN_RATE_LIMIT_MAX: '1000',
    SECURE_COOKIES: 'false',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'error',
  };
}

/** Whether the suite is running in CI — where a stray `test.only` is a red build, not a warning. */
export const IS_CI = process.env.CI !== undefined && process.env.CI !== '0';
