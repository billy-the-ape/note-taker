/**
 * The schema contract (docs/plans/mvp/MVP-04.md §4/§8): every index, constraint and default §8 lists is
 * asserted **against a real Postgres**, and the two invariants that must hold even while the repositories are
 * still being written — one owner per database, and roleless inserts that stay members — are shown here rather
 * than trusted to the file that generates them.
 *
 * This file reads the catalog instead of Drizzle's types on purpose: the schema is the thing PR-09…PR-20 build
 * on, so its proof belongs at the layer below the code that uses it. The DDL strings are matched as PostgreSQL
 * renders them (identifiers unquoted, `COALESCE` upper-cased, the predicate parenthesised as `WHERE (role =
 * 'owner'::text)`), because the *facts* — unique, partial, coalesced, descending — are what §8 pins, not the
 * spelling of a `pg_indexes` row.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, createUserPair } from '../test/fixtures.js';
import { catalogRows, resetDb, testDb } from '../test/helpers/db.js';
import { expectSqlState } from '../test/helpers/pg-error.js';
import { newId } from './ids.js';
import { folders, notes, users } from './schema.js';

/** Every index the migration is expected to create, primary keys included (`<table>_pkey`). */
const EXPECTED_INDEXES = [
  'auth_attempts_key_at_idx',
  'auth_attempts_pkey',
  'folders_pkey',
  'folders_unique_sib',
  'folders_user_parent_idx',
  'notes_pkey',
  'notes_unique_sib',
  'notes_user_content_updated_idx',
  'notes_user_folder_idx',
  'sessions_pkey',
  'sessions_user_idx',
  'settings_pkey',
  'users_one_owner_uidx',
  'users_pkey',
  'users_username_lower_uidx',
].sort();

const EXPECTED_TABLES = ['auth_attempts', 'folders', 'notes', 'sessions', 'settings', 'users'].sort();

/** The root sentinel `folders_unique_sib`/`notes_unique_sib` compare against. */
const ROOT = `'00000000-0000-0000-0000-000000000000'::uuid`;

async function indexDefs(): Promise<Map<string, string>> {
  const rows = await catalogRows(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`);
  return new Map(rows.map((row) => [String(row.indexname), String(row.indexdef)]));
}

async function columnOf(table: string, column: string): Promise<Record<string, unknown>> {
  const rows = await catalogRows(
    sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
         where table_schema = 'public' and table_name = ${table} and column_name = ${column}`,
  );
  const found = rows[0];
  if (!found) throw new Error(`${table}.${column} is not in the schema the migration created`);
  return found;
}

async function countFrom(table: 'users' | 'notes' | 'settings'): Promise<number> {
  const rows = await catalogRows(sql`select count(*)::int as total from ${sql.identifier(table)}`);
  return Number(rows[0]?.total ?? -1);
}

describe('the migrated schema (§8)', () => {
  beforeEach(async () => {
    // `src/test/setup.ts` applied the committed migration, so everything below describes what
    // `pnpm db:migrate` produces from `migrations/` — not what this file's imports declare.
    await resetDb();
    const tables = await catalogRows(
      sql`select table_name from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(tables.map((row) => String(row.table_name)).sort()).toStrictEqual(EXPECTED_TABLES);
  });

  it('creates pgcrypto, the one extension §8 asks for, in public', async () => {
    const rows = await catalogRows(
      sql`select e.extname as extname, n.nspname as nspname
            from pg_extension e join pg_namespace n on n.oid = e.extnamespace
           where e.extname = 'pgcrypto'`,
    );
    expect(rows.map((row) => `${String(row.nspname)}.${String(row.extname)}`)).toStrictEqual([
      'public.pgcrypto',
    ]);
  });

  it('creates exactly the indexes §8 names — no more, no fewer', async () => {
    const rows = await catalogRows(sql`select indexname from pg_indexes where schemaname = 'public'`);
    expect(rows.map((row) => String(row.indexname)).sort()).toStrictEqual(EXPECTED_INDEXES);
  });

  it('makes users_one_owner_uidx a PARTIAL unique index on role = owner', async () => {
    const owner = (await indexDefs()).get('users_one_owner_uidx');

    expect(owner).toMatch(/CREATE UNIQUE INDEX users_one_owner_uidx/);
    expect(owner).toMatch(/USING btree \(role\)/);
    // The predicate is the whole trick: rows with any other role simply are not in the index.
    expect(owner).toMatch(/WHERE \(role = 'owner'::text\)/);
  });

  it('folds the root into both sibling indexes with COALESCE, so root names collide too', async () => {
    const defs = await indexDefs();

    expect(defs.get('folders_unique_sib')).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX folders_unique_sib ON \\w+\\.folders USING btree \\(user_id, COALESCE\\(parent_id, ${ROOT}\\), name\\)`,
      ),
    );
    expect(defs.get('notes_unique_sib')).toMatch(new RegExp(`COALESCE\\(folder_id, ${ROOT}\\)`));
  });

  it('orders the recents and attempts indexes DESC', async () => {
    const defs = await indexDefs();

    expect(defs.get('notes_user_content_updated_idx')).toMatch(/\(user_id, content_updated_at DESC\)/);
    expect(defs.get('auth_attempts_key_at_idx')).toMatch(/\(user_key, at DESC\)/);
  });

  it('compares usernames case-insensitively through an expression index', async () => {
    const defs = await indexDefs();
    expect(defs.get('users_username_lower_uidx')).toMatch(/USING btree \(lower\(username\)\)/);

    // The behaviour, not only the DDL: two spellings of one name are one name.
    await createUser(testDb(), { username: 'Kayla', role: 'member' });
    await expectSqlState(
      createUser(testDb(), { username: 'kayla', role: 'member' }),
      '23505',
      'users_username_lower_uidx',
    );
    expect(await countFrom('users')).toBe(1);
  });

  it('cascades every user_id / parent_id / folder_id foreign key', async () => {
    const rows = await catalogRows(
      sql`select rc.constraint_name as constraint_name, rc.delete_rule as delete_rule
            from information_schema.referential_constraints rc
           where rc.constraint_schema = 'public'`,
    );
    const byName = new Map(rows.map((row) => [String(row.constraint_name), String(row.delete_rule)]));

    expect([...byName.keys()].sort()).toStrictEqual(
      [
        'folders_parent_id_folders_id_fk',
        'folders_user_id_users_id_fk',
        'notes_folder_id_folders_id_fk',
        'notes_user_id_users_id_fk',
        'sessions_user_id_users_id_fk',
        'settings_user_id_users_id_fk',
      ].sort(),
    );
    // `NO ACTION` would refuse the delete, and PR-09's delete-folder would surface it as a 500.
    expect(new Set(byName.values())).toEqual(new Set(['CASCADE']));
  });

  it('ships the CHECK constraints §8 names, and only those', async () => {
    const rows = await catalogRows(
      sql`select con.conname as conname
            from pg_constraint con join pg_namespace n on n.oid = con.connamespace
           where con.contype = 'c' and n.nspname = 'public'`,
    );
    expect(rows.map((row) => String(row.conname)).sort()).toStrictEqual([
      'folders_name_check',
      'notes_name_check',
      'settings_theme_check',
      'users_role_check',
    ]);
  });

  it('defaults role to member, never owner', async () => {
    const column = await columnOf('users', 'role');

    expect(String(column.column_default)).toContain(`'member'`);
    expect(String(column.is_nullable)).toBe('NO');
  });

  it('defaults the note counters, and gives the encrypted columns no default at all', async () => {
    const [version, keyVersion, contentBytes, wordCount, contentFormat] = await Promise.all([
      columnOf('notes', 'version'),
      columnOf('notes', 'key_version'),
      columnOf('notes', 'content_bytes'),
      columnOf('notes', 'word_count'),
      columnOf('notes', 'content_format'),
    ]);

    expect(String(version.column_default)).toBe('1');
    expect(String(keyVersion.column_default)).toBe('1');
    expect(String(contentBytes.column_default)).toBe('0');
    expect(String(wordCount.column_default)).toBe('0');
    expect(String(contentFormat.column_default)).toContain(`'markdown'`);

    // §8: the ciphertext columns have no default — an empty IV is undecryptable, and a plaintext default would
    // be the leak the whole design exists to prevent.
    const [cipher, iv, tokenHash] = await Promise.all([
      columnOf('notes', 'content_cipher'),
      columnOf('notes', 'content_iv'),
      columnOf('sessions', 'token_hash'),
    ]);
    expect(cipher.column_default).toBeNull();
    expect(iv.column_default).toBeNull();
    expect(String(cipher.data_type)).toBe('bytea');
    expect(String(iv.data_type)).toBe('bytea');
    expect(String(tokenHash.data_type)).toBe('bytea');
  });

  it('stores every timestamp as timestamptz with a server-side default', async () => {
    const columns = await catalogRows(
      sql`select table_name, column_name, data_type, column_default from information_schema.columns
           where table_schema = 'public'
             and column_name in ('created_at', 'updated_at', 'content_updated_at')`,
    );

    // 2 (folders) + 3 (notes) + 1 (sessions) + 1 (settings) + 2 (users); `auth_attempts` has none of these.
    expect(columns).toHaveLength(9);
    for (const column of columns) {
      expect(String(column.data_type)).toBe('timestamp with time zone');
      expect(String(column.column_default)).toContain('now()');
    }
  });

  it('leaves two roleless users as members, so they coexist instead of colliding on the owner index', async () => {
    const db = testDb();
    const insertRoleless = async (username: string): Promise<string> => {
      const inserted = await db
        .insert(users)
        .values({ id: newId(), username, passwordHash: 'argon2id-placeholder' })
        .returning({ role: users.role });
      return String(inserted[0]?.role);
    };

    // The invariant §4 calls the one that must not break while PR-07 is still being written, shown twice.
    await expect(insertRoleless('first')).resolves.toBe('member');
    await expect(insertRoleless('second')).resolves.toBe('member');
    expect(await countFrom('users')).toBe(2);
    expect(await countFrom('settings')).toBe(0);
  });

  it('allows exactly one owner, at the index, when a second insert asks for one', async () => {
    const db = testDb();
    const { owner } = await createUserPair(db);
    expect(owner.role).toBe('owner');

    // Two concurrent /setup attempts is the race PR-07 renders as a 409; the loser lands here, in the index.
    await expectSqlState(
      db.insert(users).values({
        id: newId(),
        username: 'second-setup',
        passwordHash: 'argon2id-placeholder',
        role: 'owner',
      }),
      '23505',
      'users_one_owner_uidx',
    );
    expect(await countFrom('users')).toBe(2);
  });

  it('rejects a role outside (owner, member) and an empty folder name through the checks', async () => {
    const db = testDb();

    await expectSqlState(
      db
        .insert(users)
        .values({ id: newId(), username: 'wants-root', passwordHash: 'argon2id-placeholder', role: 'root' }),
      '23514',
      'users_role_check',
    );

    const { owner } = await createUserPair(db);
    await expectSqlState(
      db.insert(folders).values({ id: newId(), userId: owner.id, name: '' }),
      '23514',
      'folders_name_check',
    );
  });

  it('gives notes their own name check and settings their default theme', async () => {
    const db = testDb();
    const { owner } = await createUserPair(db);

    await expectSqlState(
      db.insert(notes).values({
        id: newId(),
        userId: owner.id,
        name: '',
        contentCipher: new Uint8Array([1]),
        contentIv: new Uint8Array(12),
      }),
      '23514',
      'notes_name_check',
    );

    // One settings row per user, the way PR-07 will insert them, so `theme` is never left to the application.
    const themes = await catalogRows(sql`select theme from settings order by user_id`);
    expect(themes.map((row) => String(row.theme))).toStrictEqual(['system', 'system']);
  });
});
