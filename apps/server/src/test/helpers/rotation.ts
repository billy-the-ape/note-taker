/**
 * Driving PR-06's key rotation from an integration test (docs/plans/mvp/MVP-06.md §7–§8).
 *
 * This is `scripts/rotate-note-key.int.test.ts`'s harness, lifted into `src/test/**` because PR-10 re-tests the
 * rotation's concurrency guarantee **one layer up** (`routes/notes.content-race.int.test.ts`): PR-06 raced the
 * rotation against the repository's conditional update, and PR-10 races it against a real
 * `PUT /api/notes/:id/content`. Two files needing the same subprocess and the same two-key env is the point of
 * this module — a rotation test that quietly stopped running the script as a subprocess would still be green here
 * and wrong in CI, so the rule about *how* it is run lives in one place:
 *
 * * The script runs as **`tsx src/scripts/rotate-note-key.ts`**, never as `dist/scripts/rotate-note-key.js`: the
 *   `integration` CI job runs `pnpm build:packages` only, so the compiled form does not exist there (the `.js` is
 *   asserted by the `build` job and by PR-18's image).
 * * `DOTENV_PATH` points at a file that does not exist, which `loadDevEnvFile()` documents as a no-op, so a
 *   developer's local `.env` cannot leak into a subprocess — the env an operator would set is spelled out here and
 *   nowhere else.
 * * The env is that operator's env: the old key decrypt-only in `_PREVIOUS`, the new one current, the version
 *   bumped by hand (editing `.env` and restarting the app are the two steps a script cannot do to its own
 *   container).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';

import { buildKeyring, type Keyring } from '../../crypto/keys.js';
import type { Db } from '../../db/client.js';
import { databaseUrl } from '../../env.js';

/** Relative to `apps/server`, which is where `pnpm exec tsx` is asked to look for its local binary. */
const SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Where the script lives, relative to that root — the argument the operator types. */
export const ROTATE_SCRIPT = path.join('src', 'scripts', 'rotate-note-key.ts');

const silentLogger = pino({ level: 'silent' });

/** A 32-byte key as base64, from a seed. Test keys, throwaway by construction, and never a KMS. */
export function keyBase64(seed: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index + seed) % 251)).toString('base64');
}

export const KEY_1_B64 = keyBase64(11);
export const KEY_2_B64 = keyBase64(212);

/** The env of the app *before* the rotation: one key, version 1 (the default). */
export const envBefore: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl(),
  NOTE_ENCRYPTION_KEY: KEY_1_B64,
  // `info`, because half of these assertions read the operator's own log lines — and pino drops them below that
  // level. `error` here would make a suite assert on an empty stdout.
  LOG_LEVEL: 'info',
  DOTENV_PATH: path.join(SERVER_ROOT, 'no-such-env-file-for-tests'),
};

/** …and after: the new key is current, the old one is decrypt-only, and the version moved by hand. */
export const envAfter: Record<string, string> = {
  ...envBefore,
  NOTE_ENCRYPTION_KEY: KEY_2_B64,
  NOTE_ENCRYPTION_KEY_VERSION: '2',
  NOTE_ENCRYPTION_KEY_PREVIOUS: JSON.stringify({ 1: KEY_1_B64 }),
};

/** The keyring of {@link envBefore} — what a row written before the rotation is sealed with. */
export const keyringBefore: Keyring = buildKeyring({ source: envBefore, logger: silentLogger });

/** The keyring of {@link envAfter} — what the app is expected to write with once the rotation has run. */
export const keyringAfter: Keyring = buildKeyring({ source: envAfter, logger: silentLogger });

/** What one run of the script reported. */
export interface RotationRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The operator's command: `pnpm exec tsx src/scripts/rotate-note-key.ts [flags]`. */
export function runRotate(
  source: Record<string, string>,
  args: readonly string[] = [],
): Promise<RotationRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', ROTATE_SCRIPT, ...args], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...source },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The JSON lines pino wrote, decoded. Anything unparsable is a bug this suite would rather see than hide. */
export function rotationLogLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * How many sessions are right now blocked on a row lock inside a `… for update` walk of `notes`.
 *
 * Polling this instead of sleeping a fixed time is what makes a rotation race deterministic: the condition a test
 * needs is precisely "the script is queued behind the locker", and nothing else. A test that cannot observe that
 * has not run the race it claims to have run, which is why callers assert on the answer rather than ignore it.
 */
export async function blockedRotationWalkers(db: Db): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as waiting
          from pg_stat_activity
         where state = 'active' and wait_event_type = 'Lock'
           and query ilike '%key_version%'
           and query ilike '%from notes%'
           and query ilike '%for update%'`,
  )) as unknown as { waiting: number }[];
  return rows[0]?.waiting ?? 0;
}

/** Polls {@link blockedRotationWalkers} until the rotation is parked, and reports whether it ever was. */
export async function waitForBlockedRotation(db: Db, tries = 80): Promise<boolean> {
  for (let tick = 0; tick < tries; tick += 1) {
    if ((await blockedRotationWalkers(db)) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
