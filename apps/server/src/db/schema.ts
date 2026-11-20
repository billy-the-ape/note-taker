/**
 * The Postgres schema — the single source of truth for the data layer
 * (docs/plans/mvp/MVP-04.md §4; the SQL it generates lives in `migrations/`).
 *
 * Conventions this file keeps:
 *
 * * **UUID primary keys, generated in the application.** There is no SQL id default: every insert goes
 *   through the one `newId()` in `db/ids.ts`, so a row's id is known before the statement runs.
 * * **`user_id` is NOT NULL on every row that belongs to someone.** The FKs below deliberately do NOT
 *   carry `user_id`, so the repositories scope every query with `WHERE user_id = <auth userId>` — cross-user
 *   access is a `404`, never a `403` (and PR-09's services must scope-load target folders).
 * * **No plaintext anywhere.** `notes.content_cipher`/`content_iv` have no default on purpose: an empty IV
 *   would be undecryptable, and a plain-text default would be the leak the whole schema exists to prevent.
 *   `crypto/envelope.ts` (PR-06) is the only writer of that triple.
 * * **No soft delete** (backlog PR-23): deletes are hard, and `ON DELETE CASCADE` does the tree work.
 *
 * Every index and constraint carries the name the brief names it by, so the `pg_indexes`/`pg_constraint`
 * output in `docs/DATA-MODEL.md` matches this file, and `schema.int.test.ts` asserts the pair agree.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `bytea` — the binary column type (§8's `content_cipher`, `content_iv`, `token_hash`).
 *
 * drizzle-orm 0.44.x and 0.45.x do not export a `bytea` builder from `drizzle-orm/pg-core` (the docs show one,
 * the published builds do not ship it), so the type is declared through drizzle's documented custom-type
 * escape hatch instead of pinned to an older ORM. What matters is that the two things later PRs depend on are
 * unchanged:
 *
 * * the DDL drizzle-kit emits is `bytea`, exactly the column type §8 specifies — this is the only place the
 *   name appears, and `pnpm db:generate` proves it;
 * * the TypeScript type is `Uint8Array`, not `Buffer`: PR-06's `seal()` returns `Uint8Array`, and the driver's
 *   `Buffer` is a subclass of it, so no `toDriver`/`fromDatabase` mapping is needed in either direction.
 *
 * If a later drizzle-orm ships `bytea` natively, this is a one-line swap in `schema.ts` and the migration
 * output stays identical.
 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array; driverOutput: Uint8Array }>({
  dataType: () => 'bytea',
});

/**
 * The value `COALESCE(parent_id, …)` folds `NULL` (root) into, so the two "sibling name" unique indexes can
 * see root rows at all: a plain `UNIQUE (user_id, parent_id, name)` ignores every NULL, which would let one
 * user create unlimited root folders with the same name.
 */
const ROOT_PARENT_ID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

/** The only two values `users.role` takes; `owner` is written by `/setup` alone (PR-07). */
export const USER_ROLES = ['owner', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** The themes `settings.theme` takes. */
export const SETTINGS_THEMES = ['system', 'light', 'dark'] as const;
export type SettingsTheme = (typeof SETTINGS_THEMES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Compared case-insensitively by `users_username_lower_uidx`; stored exactly as typed. */
    username: text('username').notNull(),
    /** The argon2id encoded string (PR-07) — never a password, and never a plaintext column. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    /**
     * LEAST-privilege on purpose: with `users_one_owner_uidx` below, an insert that forgets `role` must
     * never mint an owner (a second such row would die on that index), so the default is `member` and only
     * `/setup` writes `owner`, explicitly. Services still pass `role` and never lean on the default.
     */
    role: text('role').notNull().default('member'),
    passwordSetAt: timestamp('password_set_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_lower_uidx').on(sql`lower(${t.username})`),
    /**
     * Exactly one owner, enforced by the DB instead of a read-then-insert race: a second concurrent `/setup`
     * attempt hits this index and gets a unique violation. PR-07 owns the concurrent-setup test;
     * `schema.int.test.ts` proves the index itself, at the layer where the invariant lives.
     */
    uniqueIndex('users_one_owner_uidx').on(t.role).where(sql`${t.role} = 'owner'`),
    check('users_role_check', sql`${t.role} in ('owner', 'member')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** `sha256(session_token)`; the raw token only ever exists inside the cookie. */
    tokenHash: bytea('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `NULL` = root. The cycle check (PR-09) runs in a transaction that FIRST takes
     * `pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))`: one lock per user
     * serializes folder create/move/delete. Locking only the two affected rows is NOT enough — two moves can
     * lock disjoint pairs (X→Y and Z→W), each pass its own ancestor walk, and commit a cycle.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('folders_unique_sib').on(t.userId, sql`coalesce(${t.parentId}, ${ROOT_PARENT_ID})`, t.name),
    index('folders_user_parent_idx').on(t.userId, t.parentId),
    check('folders_name_check', sql`${t.name} <> ''`),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `NULL` = root (mirrors `folders.parent_id`). */
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    /** WITHOUT the `.md` suffix: `stripMd()` in `contracts/names.ts` (PR-05) is applied by PR-09. */
    name: text('name').notNull(),
    /** Bumped on every content write; optimistic concurrency (PR-10) turns a stale write into a 409. */
    version: integer('version').notNull().default(1),
    /** AES-256-GCM ciphertext || 16-byte tag. Opaque to this layer; PR-06's envelope is the only writer. */
    contentCipher: bytea('content_cipher').notNull(),
    /** 12 bytes, per-write random. No default: an empty IV is undecryptable. */
    contentIv: bytea('content_iv').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    contentFormat: text('content_format').notNull().default('markdown'),
    /** Plaintext byte length, so a listing never decrypts (PR-11's search reads the same column). */
    contentBytes: integer('content_bytes').notNull().default(0),
    wordCount: integer('word_count').notNull().default(0),
    contentUpdatedAt: timestamp('content_updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notes_unique_sib').on(t.userId, sql`coalesce(${t.folderId}, ${ROOT_PARENT_ID})`, t.name),
    index('notes_user_folder_idx').on(t.userId, t.folderId),
    index('notes_user_content_updated_idx').on(t.userId, sql`${t.contentUpdatedAt} desc`),
    check('notes_name_check', sql`${t.name} <> ''`),
  ],
);

/**
 * One row per user, inserted in the SAME transaction as the `users` row (PR-07);
 * `settings.service.get()` get-or-creates as the belt for rows made outside it (PR-04 fixtures, seeds,
 * restores). There is no trigger in this schema.
 */
export const settings = pgTable(
  'settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    autosave: boolean('autosave').notNull().default(true),
    theme: text('theme').notNull().default('system'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('settings_theme_check', sql`${t.theme} in ('system', 'light', 'dark')`)],
);

/** Durable rate-limit / lockout evidence (PR-07): a process restart must not clear the lockout. */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: uuid('id').primaryKey(),
    /** `lower(username)` or an IP, so an attempt against a user that does not exist is still recorded. */
    userKey: text('user_key').notNull(),
    succeeded: boolean('succeeded').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_attempts_key_at_idx').on(t.userKey, sql`${t.at} desc`)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type AuthAttempt = typeof authAttempts.$inferSelect;

/** Everything this file declares, in the shape `drizzle(client, { schema })` wants. */
export const schema = { users, sessions, folders, notes, settings, authAttempts };
