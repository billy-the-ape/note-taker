/**
 * The migration runner (docs/plans/mvp/MVP-04.md §4/§6): the committed SQL is found from either side of the
 * build, a run against an up-to-date database applies nothing, and a run with no journal refuses to proceed.
 *
 * `src/test/setup.ts` already applied `migrations/` before this file runs, so "applied 0" below is the
 * idempotence proof §4 asks for; the fresh-database half of the story is the `pnpm db:migrate` step in §6, run
 * against an empty cluster (see the PR description).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { catalogRows } from '../test/helpers/db.js';
import { migrateDatabase, migrationsDir } from './migrate.js';

describe('migrationsDir()', () => {
  it('resolves apps/server/migrations through the package root, not through a relative path', () => {
    const dir = migrationsDir();

    expect(dir).toMatch(/apps[\\/]server[\\/]migrations$/);
    expect(existsSync(join(dir, 'meta', '_journal.json'))).toBe(true);
  });

  it('resolves the same folder from the compiled tree it will one day sit in', () => {
    // The other side of the build (docs/plans/mvp/MVP-04.md §4): `pnpm build` emits `dist/db/migrate.js`, where
    // a literal `'../migrations'` would have pointed at `dist/migrations` and shipped an image that cannot
    // create its own schema. Walking up to the nearest `package.json` does not care which tree it is in — and
    // it does not require the directory to exist, which is what lets this be a test rather than an acceptance
    // step (the acceptance step, `node dist/index.js`, is §6's).
    const fromDist = migrationsDir(join(process.cwd(), 'dist', 'db'));

    expect(fromDist).toBe(migrationsDir());
    expect(fromDist).toMatch(/apps[\\/]server[\\/]migrations$/);
  });
});

describe('migrateDatabase()', () => {
  it('is idempotent: a second run applies nothing, and the history still matches the journal', async () => {
    const first = await migrateDatabase();
    const second = await migrateDatabase();

    expect(first.total).toBeGreaterThan(0);
    expect(first.applied).toBe(0);
    expect(second).toStrictEqual(first);

    const rows = await catalogRows(sql`select count(*)::int as total from drizzle.__drizzle_migrations`);
    expect(Number(rows[0]?.total)).toBe(first.total);
  });

  it('opens and closes its own pool when no pool is supplied', async () => {
    const result = await migrateDatabase({});

    // The standalone path (`pnpm db:migrate`, a future `db:seed`) must not leave the process unable to exit.
    expect(result.applied).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('refuses to run against a folder with no journal, naming the folder and the remedy', async () => {
    const missing = join(migrationsDir(), 'not-a-migrations-folder');

    await expect(migrateDatabase({ folder: missing })).rejects.toThrow(
      /no migration journal in .*pnpm db:generate/,
    );
  });

  it('ships the §8 contract in the committed SQL, which is what a fresh database would run', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = migrationsDir();
    const sqlFiles = readdirSync(dir).filter((file) => file.endsWith('.sql'));
    const text = sqlFiles.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');

    expect(sqlFiles).toHaveLength(1);
    expect(text).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    for (const expected of [
      'CREATE UNIQUE INDEX "users_one_owner_uidx"',
      'WHERE "users"."role" = \'owner\'',
      'CREATE UNIQUE INDEX "folders_unique_sib"',
      'coalesce("parent_id", \'00000000-0000-0000-0000-000000000000\'::uuid)',
      'CREATE UNIQUE INDEX "notes_unique_sib"',
      // Lower-case `desc`, the way drizzle-kit writes it; `pg_indexes` renders the same fact upper-case.
      '"content_updated_at" desc',
      '"at" desc',
      '"auth_attempts_key_at_idx"',
      'REFERENCES "public"."users"("id") ON DELETE cascade',
      '"content_cipher" "bytea" NOT NULL',
      '"role" text DEFAULT \'member\' NOT NULL',
    ]) {
      expect(text).toContain(expected);
    }
  });
});
