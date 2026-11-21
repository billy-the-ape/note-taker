/**
 * The note-key rotation script (docs/plans/mvp/MVP-06.md §7).
 *
 * It rewrites every note body that was sealed with an older `key_version` so it is readable with the current
 * key alone, which is what eventually lets a retired key leave `NOTE_ENCRYPTION_KEY_PREVIOUS`. It lives under
 * `apps/server/src/` **on purpose**: it is TypeScript inside the server workspace, so `pnpm build` emits
 * `apps/server/dist/scripts/rotate-note-key.js` and PR-18's image ships it. Its dependencies are the ones that
 * ship with the app — `env.ts`, `db/client.ts`, `crypto/*`, `logger.ts` — and no dev-only helper, because in
 * production it is run inside the container:
 *
 * ```
 * docker compose --env-file .env -f docker/compose.yml exec app \
 *   node apps/server/dist/scripts/rotate-note-key.js
 * docker compose --env-file .env -f docker/compose.yml exec app \
 *   node apps/server/dist/scripts/rotate-note-key.js --verify
 * ```
 *
 * ## What it does per batch, in one transaction
 *
 * ```sql
 * SELECT id, version, key_version, content_cipher, content_iv
 *   FROM notes WHERE key_version < $current AND id > $cursor ORDER BY id LIMIT $batch FOR UPDATE
 * ```
 *
 * — the row lock is what makes read-and-reseal atomic — and then the write is conditional:
 *
 * ```sql
 * UPDATE notes SET content_cipher = …, content_iv = …, key_version = $current, updated_at = now()
 *  WHERE id = $1 AND version = $2 AND key_version = $old
 * ```
 *
 * If that matches 0 rows the row changed under the script: it is **re-read and the freshly read ciphertext is
 * re-sealed**, never a previously buffered one, and if it is still behind the current version the write is
 * retried once inside the same lock.
 *
 * * It never touches `notes.version`: rotation is not a content edit, and bumping it would spuriously trip
 *   every open tab's autosave into a 409. It likewise leaves `content_updated_at` alone, so the "recent notes"
 *   order does not shuffle because a key was rotated.
 * * It is **idempotent**: rows already at the current version are not selected, so a second run rewrites
 *   nothing, and a run interrupted halfway can simply be re-run.
 * * Batches advance by keyset on `id` (streaming, never an `OFFSET` walk and never the whole table in memory),
 *   so a row that cannot be decrypted is reported and skipped rather than wedging the loop.
 *
 * ## Exit codes
 *
 * | Code | Meaning                                                              |
 * | ---- | -------------------------------------------------------------------- |
 * | 0    | nothing left on an old key version (or `--dry-run` found nothing to do) |
 * | 1    | rows still need rotating, failed to decrypt, or are **ahead** of this configuration |
 * | 2    | the process could not start: bad arguments, or a keyring/env failure |
 *
 * `--verify` is read-only and is the operator's stopping condition: re-run the rotation until `--verify` exits 0.
 */
import process from 'node:process';

import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { decrypt, encrypt, noteAad } from '../crypto/envelope.js';
import { buildKeyring, type Keyring } from '../crypto/keys.js';
import { createDb, type Db } from '../db/client.js';
import { EnvError, loadDevEnvFile, parseEnv } from '../env.js';
import { createLogger } from '../logger.js';

/** Rows re-sealed per transaction. Big batches are fewer round trips; small ones hold fewer row locks. */
export const DEFAULT_BATCH_SIZE = 500;

const USAGE = `rotate-note-key — re-encrypt note bodies onto the current NOTE_ENCRYPTION_KEY_VERSION

  --verify        read-only: report rows per key_version, exit 1 unless every row is current
  --dry-run       do the whole walk without writing (row locks are not taken either)
  --batch=N       rows per transaction (default ${DEFAULT_BATCH_SIZE})
  -h, --help      this text

Reads the same env the app does: DATABASE_URL (or POSTGRES_*), NOTE_ENCRYPTION_KEY[_FILE],
NOTE_ENCRYPTION_KEY_VERSION and NOTE_ENCRYPTION_KEY_PREVIOUS. Run it after the operator has appended the
retired key to NOTE_ENCRYPTION_KEY_PREVIOUS, set the new key and bumped the version, then re-run --verify
until it exits 0.`;

export interface RotateOptions {
  readonly batch: number;
  readonly dryRun: boolean;
  readonly verify: boolean;
}

type RunResult = 'help' | { readonly options: RotateOptions };

/** @throws {Error} on an unrecognised flag or a nonsense batch size, because a typo here must not rewrite rows. */
export function parseRotateArgs(argv: readonly string[]): RunResult {
  let batch = DEFAULT_BATCH_SIZE;
  let dryRun = false;
  let verify = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return 'help';
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (arg.startsWith('--batch=')) {
      const raw = arg.slice('--batch='.length);
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
        throw new Error(`--batch must be a whole number between 1 and 100000, got ${JSON.stringify(raw)}`);
      }
      batch = parsed;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)} (try --help)`);
  }

  return { options: { batch, dryRun, verify } };
}

/** One row of the walk: the triple, plus the `version` the conditional write is compared against. */
export interface RotatableRow {
  readonly id: string;
  readonly version: number;
  readonly keyVersion: number;
  readonly contentCipher: Uint8Array;
  readonly contentIv: Uint8Array;
}

/** What one pass over the table did. */
export interface RotateSummary {
  /** Rows re-sealed onto the current version by this run. */
  resealed: number;
  /** Rows whose conditional write matched 0 rows and had to be re-read (§7). */
  reread: number;
  /** Rows this run left alone because they were already current, or changed to current under us. */
  skipped: number;
  /** Rows it could not read at all — a missing key version or a body that does not authenticate. */
  failed: string[];
}

export function emptySummary(): RotateSummary {
  return { resealed: 0, reread: 0, skipped: 0, failed: [] };
}

/**
 * `bytea` comes back as a `Uint8Array` (`Buffer` is one), and a script that found anything else would be
 * looking at a column this envelope never wrote — so the shape is checked here, once, rather than deep in
 * `decrypt()`.
 */
function bytesFrom(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`notes.${what} is not bytea-shaped (${typeof value})`);
}

function rowFrom(raw: Record<string, unknown>): RotatableRow {
  const version = Number(raw.version);
  const keyVersion = Number(raw.key_version);
  if (typeof raw.id !== 'string' || !Number.isSafeInteger(version) || !Number.isSafeInteger(keyVersion)) {
    throw new Error(`rotation row is missing id/version/key_version: ${JSON.stringify(Object.keys(raw))}`);
  }
  return {
    id: raw.id,
    version,
    keyVersion,
    contentCipher: bytesFrom(raw.content_cipher, 'content_cipher'),
    contentIv: bytesFrom(raw.content_iv, 'content_iv'),
  };
}

/** `key_version → row count`, the report both modes print and the only evidence `--verify` needs. */
export async function rowsPerKeyVersion(db: Db): Promise<Map<number, number>> {
  const rows = (await db.execute(
    sql`select key_version, count(*)::bigint as rows from notes group by key_version order by key_version`,
  )) as unknown as { readonly key_version: number; readonly rows: bigint | string }[];

  const counts = new Map<number, number>();
  for (const row of rows) counts.set(Number(row.key_version), Number(row.rows));
  return counts;
}

function formatCounts(counts: Map<number, number>): string {
  if (counts.size === 0) return 'no notes in the database';
  return [...counts.entries()].map(([version, rows]) => `key_version ${version}: ${rows}`).join(', ');
}

/**
 * The stopping condition. Exits 1 while **any** row is off the current version — behind (still needs the
 * rewrite) or ahead (this process's `NOTE_ENCRYPTION_KEY_VERSION` is below what the database holds, which is
 * the configuration error of pointing an old env at a rotated database).
 */
export async function verify(db: Db, keyring: Keyring, logger: Logger): Promise<number> {
  const counts = await rowsPerKeyVersion(db);
  const total = [...counts.values()].reduce((sum, rows) => sum + rows, 0);
  const current = keyring.current.version;
  const behind = [...counts.entries()].filter(([version]) => version < current);
  const ahead = [...counts.entries()].filter(([version]) => version > current);

  logger.info(
    { keyVersion: current, rows: total, counts: Object.fromEntries(counts) },
    `notes by key_version: ${formatCounts(counts)}`,
  );

  if (behind.length === 0 && ahead.length === 0) {
    logger.info({ rows: total }, `every note is sealed with key_version ${current}`);
    return 0;
  }
  if (behind.length > 0) {
    logger.error(
      { behind: Object.fromEntries(behind) },
      `notes remain on an older key version — run rotate-note-key without --verify, then re-run --verify`,
    );
  }
  if (ahead.length > 0) {
    logger.error(
      { ahead: Object.fromEntries(ahead), keyVersion: current },
      `notes were written with a key version above NOTE_ENCRYPTION_KEY_VERSION=${current}: this process is ` +
        'behind the database (the wrong env, or the version was bumped before the rewrite finished)',
    );
  }
  return 1;
}

/** The conditional write of §7, as a statement so its shape stays visible. */
function resealStatement(row: RotatableRow, keyVersion: number, cipher: Uint8Array, iv: Uint8Array) {
  return sql`
    update notes
       set content_cipher = ${cipher},
           content_iv = ${iv},
           key_version = ${keyVersion},
           updated_at = now()
     where id = ${row.id} and version = ${row.version} and key_version = ${row.keyVersion}
     returning id`;
}

/** The re-read of §7: the columns as they are *now*, under the row lock we already hold. */
async function rereadRow(db: Db, id: string): Promise<RotatableRow | undefined> {
  const found = (await db.execute(
    sql`select id, version, key_version, content_cipher, content_iv from notes where id = ${id}`,
  )) as unknown as Record<string, unknown>[];
  const raw = found[0];
  return raw === undefined ? undefined : rowFrom(raw);
}

/**
 * Re-seals one row onto the current key, and writes it only if the row is still the one that was read.
 *
 * Exported for `rotate-note-key.int.test.ts`, which drives the stale-buffer case directly: holding the row
 * lock while a second writer lands is how §7's "never write a previously buffered one" is proved without
 * depending on which of two waiting transactions Postgres wakes first.
 *
 * @returns `false` when the row was left as it is (deleted, or already at the current version after the
 *   re-read). A row that changed is never written from a buffered plaintext: the fresh bytes are decrypted
 *   again, which is the only way the writer that beat us here keeps its own content.
 */
export async function resealAndWrite(
  tx: Db,
  row: RotatableRow,
  keyring: Keyring,
  summary: RotateSummary,
  logger: Logger,
): Promise<boolean> {
  const seal = (source: RotatableRow): { cipher: Uint8Array; iv: Uint8Array } => {
    // AAD is `note:<uuid>` on both sides, so a body cannot be moved between rows or read with the wrong key.
    const plain = decrypt(
      { cipher: source.contentCipher, iv: source.contentIv, keyVersion: source.keyVersion },
      { aad: noteAad(source.id), keyring, noteId: source.id },
    );
    const sealed = encrypt(plain, { aad: noteAad(source.id), keyring });
    return { cipher: sealed.cipher, iv: sealed.iv };
  };

  let written: unknown[];
  try {
    const sealed = seal(row);
    written = (await tx.execute(
      resealStatement(row, keyring.current.version, sealed.cipher, sealed.iv),
    )) as unknown[];
  } catch (error) {
    // One unreadable row is an incident for that row, not a reason to abandon a live database mid-rotation.
    summary.failed.push(row.id);
    logger.error({ noteId: row.id, keyVersion: row.keyVersion, err: error }, 'could not re-seal this note');
    return false;
  }

  if (written.length > 0) {
    summary.resealed += 1;
    return true;
  }

  // 0 rows: the row moved under us (autosave wrote it, or a previous partial run already rotated it). Re-read
  // it and reseal what is stored now, inside the same transaction, so nothing buffered is ever written back.
  const fresh = await rereadRow(tx, row.id);
  if (fresh === undefined) {
    summary.skipped += 1;
    logger.warn({ noteId: row.id }, 'note was deleted during the rotation; nothing to do');
    return false;
  }
  if (fresh.keyVersion === keyring.current.version) {
    summary.skipped += 1;
    return false;
  }

  summary.reread += 1;
  logger.info(
    { noteId: row.id, readVersion: row.version, freshVersion: fresh.version, keyVersion: fresh.keyVersion },
    'note changed during the rotation; re-sealing the freshly read ciphertext',
  );
  try {
    const sealed = seal(fresh);
    const retried = (await tx.execute(
      resealStatement(fresh, keyring.current.version, sealed.cipher, sealed.iv),
    )) as unknown[];
    if (retried.length > 0) {
      summary.resealed += 1;
      return true;
    }
  } catch (error) {
    summary.failed.push(fresh.id);
    logger.error({ noteId: fresh.id, err: error }, 'the re-read note could not be re-sealed either');
    return false;
  }

  // Still 0 rows: someone is writing this note faster than the rotation can follow. Leave it for the next run.
  summary.skipped += 1;
  logger.warn(
    { noteId: fresh.id },
    'note changed again before the write landed; the next run will pick it up',
  );
  return false;
}

/** One batch, in one transaction: `FOR UPDATE` here is what makes the read-and-reseal atomic. */
async function rotateBatch(
  db: Db,
  keyring: Keyring,
  options: RotateOptions,
  cursor: string,
  summary: RotateSummary,
  logger: Logger,
): Promise<{ rows: number; lastId: string }> {
  const select = (lock: boolean) => sql`
    select id, version, key_version, content_cipher, content_iv
      from notes
     where key_version < ${keyring.current.version} and id > ${cursor}
     order by id
     limit ${options.batch}
     ${lock ? sql`for update` : sql``}`;

  if (options.dryRun) {
    const found = (await db.execute(select(false))) as unknown as Record<string, unknown>[];
    const rows = found.map(rowFrom);
    // A dry run reports what it *would* rewrite in the same field, so the two modes print one comparable
    // number instead of two meanings of "skipped"; nothing is written and no row lock is taken.
    summary.resealed += rows.length;
    return { rows: rows.length, lastId: rows.at(-1)?.id ?? cursor };
  }

  return db.transaction(async (tx) => {
    const found = (await tx.execute(select(true))) as unknown as Record<string, unknown>[];
    const rows = found.map(rowFrom);
    for (const row of rows) await resealAndWrite(tx, row, keyring, summary, logger);
    return { rows: rows.length, lastId: rows.at(-1)?.id ?? cursor };
  });
}

/**
 * Walks the table to the end. The loop terminates on `rows === 0` because the cursor only ever moves forward
 * — a row that fails to decrypt is skipped, and keyset pagination means it is not selected again next batch
 * (which is why the failure list is reported rather than silently dropped).
 */
export async function rotate(
  db: Db,
  keyring: Keyring,
  options: RotateOptions,
  logger: Logger,
): Promise<{
  summary: RotateSummary;
  exitCode: number;
}> {
  const summary = emptySummary();
  let cursor = '00000000-0000-0000-0000-000000000000';
  let batches = 0;

  for (;;) {
    const batch = await rotateBatch(db, keyring, options, cursor, summary, logger);
    if (batch.rows === 0) break;
    batches += 1;
    cursor = batch.lastId;
    if (batch.rows < options.batch) break;
    logger.debug({ batch: batches, cursor }, 'rotation batch committed');
  }

  logger.info(
    {
      ...summary,
      batches,
      keyVersion: keyring.current.version,
      dryRun: options.dryRun,
      failed: summary.failed,
    },
    options.dryRun
      ? `dry run: ${summary.resealed === 0 ? 'nothing would be rewritten' : 'would rewrite rows'} ` +
          'and wrote nothing (rows behind the current version are reported and left alone)'
      : 'note-key rotation finished',
  );

  const exitCode = summary.failed.length > 0 ? 1 : await verify(db, keyring, logger);
  return { summary, exitCode };
}

/** `process.exitCode`, never `process.exit()`: the pool has to close before the process may leave. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: RunResult;
  try {
    parsed = parseRotateArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // The repo-root `.env` is how a host run finds the same `POSTGRES_*` the dev container uses; in production
  // the file is absent and this is a no-op, and the container gets its env from Compose either way.
  loadDevEnvFile();
  const env = parseEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV).child({ script: 'rotate-note-key' });

  let keyring: Keyring;
  try {
    keyring = buildKeyring({ logger });
  } catch (error) {
    if (error instanceof EnvError) {
      for (const problem of error.problems) logger.error({ problem }, 'keyring refused to build');
      return 2;
    }
    throw error;
  }

  logger.info(
    { keyVersion: keyring.current.version, ...parsed.options },
    'rotate-note-key starting (this process never changes notes.version)',
  );

  const handle = createDb({ max: 1 });
  try {
    if (parsed.options.verify) return await verify(handle.db, keyring, logger);
    const { exitCode } = await rotate(handle.db, keyring, parsed.options, logger);
    return exitCode;
  } finally {
    await handle.close();
  }
}

/**
 * The self-run guard. `pnpm build` emits this file as `dist/scripts/rotate-note-key.js` and PR-18's image runs
 * it, while the integration suite *imports* it to assert the pieces — so "am I the entry point?" has to be
 * answered without `import.meta.main` (Node 24+ only) and without a top-level await in a shipped file. A test
 * runner is always `argv[1]`, never a file named like this one.
 */
const invokedDirectly =
  process.argv[1] !== undefined && /rotate-note-key\.[cm]?[jt]s$/u.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`rotate-note-key failed: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
