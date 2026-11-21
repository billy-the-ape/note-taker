# Note Taker — data model

The data layer as it is actually built, not as it was planned. It is the contract PR-06 (crypto), PR-07 (auth),
PR-09 (folder/file services) and PR-10 (versions) build on, so **a PR that changes a table, an index, a
constraint or a default rewrites the affected section here in the same PR** — the schema is generated from
`apps/server/src/db/schema.ts`, and this file is generated-by-humans documentation of what that file asks
Postgres to enforce.

| As-built       | Location                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| Schema         | `apps/server/src/db/schema.ts` (the single source of truth)                   |
| Migrations     | `apps/server/migrations/` — committed SQL + `meta/_journal.json`              |
| Client / pool  | `apps/server/src/db/client.ts` (postgres.js + `drizzle-orm/postgres-js`)      |
| Migration API  | `apps/server/src/db/migrate.ts` (`migrateDatabase()`, run at boot)            |
| Repositories   | `apps/server/src/db/repositories/{folders,notes}.repo.ts`                     |
| Proof          | `apps/server/src/db/**/*.int.test.ts` — 54 tests, run only by `pnpm test:integration` |

Nothing here is enforced by the application alone. If a rule matters, it is a constraint or an index in the
database, and an integration test that would fail if it were dropped.

## 1. Conventions

- **Identifiers** are `uuid` primary keys, generated in the application by exactly one helper —
  `newId()` in `apps/server/src/db/ids.ts`, UUIDv7 (`uuid`'s `v7`) as chosen in plan §8 (Data model); the
  package the plan and the brief named, `@uuidjs/uuid-v7`, does not exist on the registry, and §8 below
  records that substitution. Postgres'
  `gen_random_uuid()` stays unused, which is why `pgcrypto` exists in the schema as an operational
  affordance (§8) rather than as a code path.
- **Ownership** is explicit on every table that holds user data (`user_id`), and every repository function
  takes `{ userId }` and puts it in the `WHERE` clause — the index alone is not an authorisation check.
  A row that is not yours reads as *absent* (`undefined`), which PR-09 renders as a 404, never as a 403 with
  a reason.
- **Folders and notes are separate tables**, never a self-join `parent_id` tree; `folders.parent_id` is a
  self-reference for the tree inside the table, and `NULL` means the root (§3).
- **Note content is never plaintext, in any environment.** `notes` has no plaintext column, no plaintext
  flag and no plaintext code path: it stores an opaque `(content_cipher, content_iv, key_version)` triple
  written only by `crypto/envelope.ts` (PR-06). The repositories accept the triple as supplied bytes and never
  see plaintext; their tests insert fixed test blobs.
- **`bytea` maps to `Uint8Array`**, in both directions, because drizzle-orm returns `Uint8Array` and
  `postgres` sends any `Uint8Array` as `bytea` (§9). Nothing casts ciphertext through `text`, and no column
  default exists for either ciphertext column — an empty IV is undecryptable, and a default would be the leak.
- **Timestamps are `timestamptz`**, with `DEFAULT now()` server-side so a row is never written without one.
  `updated_at` is **not** maintained by the database: there is no trigger, and each repository statement sets
  it in the same `UPDATE` it is writing for the sake of. A future PR that adds a trigger must delete those
  assignments rather than keep both.
- **Sibling names are compared exactly**, case-sensitively, via the unique indexes below (two notes called
  `a.md` and `A.md` in one folder are two notes). Only `users.username` is case-insensitive, and only through
  its `lower()` index.
- **Listing order is the database's.** `listFolders`/`listNotes` order by `name` and never re-sort in
  JavaScript, so the tree PR-16 renders matches `folders_user_parent_idx`/`notes_user_folder_idx` and matches
  another installation running the same collation. Names compare as *text*, which is why `10` follows `1` and
  precedes `2` in a file tree. How punctuation and mixed case rank is the **cluster's collation**, not a promise
  this schema makes — `C` puts `-` (0x2D) before `0` (0x30) where glibc `en_US.UTF-8` ignores it at the primary
  level — so nothing in this repository, least of all a test, may spell out an order that depends on it.
- **Deletes are hard.** No soft-delete column and no trash (backlog PR-23); `ON DELETE CASCADE` does the
  cascade and the tests prove it.

## 2. Tables

Column types are what `information_schema` reports after `pnpm db:migrate`.

### `users`

| Column            | Type                       | Notes                                                    |
| ----------------- | -------------------------- | -------------------------------------------------------- |
| `id`              | `uuid`                     | PK                                                        |
| `username`        | `text NOT NULL`            | unique through `lower(username)` — no DB-level CI collation |
| `password_hash`   | `text NOT NULL`            | argon2id encoded string (PR-07 writes it)                 |
| `display_name`    | `text`                     | nullable; never used to log in                            |
| `role`            | `text NOT NULL DEFAULT 'member'` | CHECK `role IN ('owner','member')`; see §2.1        |
| `password_set_at` | `timestamptz NOT NULL DEFAULT now()` | rehash trigger (PR-15) compares against this    |
| `created_at`      | `timestamptz NOT NULL DEFAULT now()` |                                              |
| `updated_at`      | `timestamptz NOT NULL DEFAULT now()` |                                              |

### `sessions`

| Column         | Type                                 | Notes                                                       |
| -------------- | ------------------------------------ | ----------------------------------------------------------- |
| `token_hash`   | `bytea` PK                           | sha256 of the session token, never the token itself (PR-07)  |
| `user_id`      | `uuid NOT NULL → users(id) CASCADE`  |                                                              |
| `expires_at`   | `timestamptz NOT NULL`               |                                                             |
| `created_at`   | `timestamptz NOT NULL DEFAULT now()`  |                                                             |
| `last_seen_at` | `timestamptz NOT NULL DEFAULT now()`  | throttled touch (PR-07)                                      |
| `user_agent`   | `text`                               | nullable, for the session list                               |

*As-built:* there is no `remember` column. Whether a cookie is durable is decided by its `Max-Age`, which is
derived from `expires_at`; a column nothing reads would only create a second, contradictable answer.

### `folders`

| Column       | Type                                  | Notes                                                   |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| `id`         | `uuid` PK                              |                                                          |
| `user_id`    | `uuid NOT NULL → users(id) CASCADE`    |                                                          |
| `parent_id`  | `uuid → folders(id) CASCADE`          | `NULL` = root; the cycle check is PR-09's, see §3         |
| `name`       | `text NOT NULL` + `folders_name_check` (`name <> ''`) | no suffix magic — a folder is named exactly              |
| `created_at` | `timestamptz NOT NULL DEFAULT now()`   |                                                          |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()`   | set by the repository, not by a trigger                  |

### `notes`

| Column               | Type                                    | Notes                                                  |
| -------------------- | --------------------------------------- | ------------------------------------------------------ |
| `id`                 | `uuid` PK                                |                                                         |
| `user_id`            | `uuid NOT NULL → users(id) CASCADE`      |                                                         |
| `folder_id`          | `uuid → folders(id) CASCADE`            | `NULL` = root, mirroring `folders.parent_id`             |
| `name`               | `text NOT NULL` + `notes_name_check` (`name <> ''`) | WITHOUT the `.md` suffix; `stripMd()` (PR-05) is applied by PR-09 |
| `version`            | `integer NOT NULL DEFAULT 1`             | optimistic lock, §4                                     |
| `content_cipher`     | `bytea NOT NULL`                         | `ciphertext ‖ 16-byte GCM tag`; **no default** (§1), and only `crypto/envelope.ts` (PR-06) writes it |
| `content_iv`         | `bytea NOT NULL`                         | 12 bytes, fresh per write; **no default**               |
| `key_version`        | `integer NOT NULL DEFAULT 1`             | which key sealed *this row*; rewritten by `scripts/rotate-note-key.ts` (PR-06) |
| `content_format`     | `text NOT NULL DEFAULT 'markdown'`       | forward-compatible; a later upload PR writes `'html'`   |
| `content_bytes`      | `integer NOT NULL DEFAULT 0`             | plaintext bytes, so the 1 MiB limit is answerable without decrypting (PR-10) |
| `word_count`         | `integer NOT NULL DEFAULT 0`              | recents + PR-12 search preview                          |
| `content_updated_at` | `timestamptz NOT NULL DEFAULT now()`      | the recents order; PR-12's "last edited" filter         |
| `created_at`         | `timestamptz NOT NULL DEFAULT now()`      |                                                         |
| `updated_at`         | `timestamptz NOT NULL DEFAULT now()`      |                                                         |

`word_count`/`content_bytes` describe the *decrypted* document and are supplied by the caller that sealed the
ciphertext; the database cannot compute them and does not pretend to.

Those three columns are one envelope, and only `crypto/envelope.ts` (PR-06) knows its shape: AES-256-GCM with a
fresh 12-byte IV per write, the auth tag appended to the ciphertext (`node:crypto` never appends it), and
`AAD = "note:" || notes.id`. A body therefore cannot be copied onto another row and read, and a row whose tag
does not verify raises instead of serving an empty note. `key_version` means *the key that sealed this row*, not
"the version this server is configured with": rows written under an older version stay readable for exactly as
long as that key sits in `NOTE_ENCRYPTION_KEY_PREVIOUS` (decrypt-only), and the explicit
`NOTE_ENCRYPTION_KEY_VERSION` exists so a rotation never has to infer the current version from that map.
`apps/server/src/scripts/rotate-note-key.ts` rewrites rows onto the current version so the old entry can
eventually be dropped. Losing the current key makes every note body unrecoverable; that is ADR-0002's (PR-20)
accepted trade and PR-18's backup drill, not a bug this schema can fix.

### `settings`

| Column      | Type                             | Notes                                            |
| ----------- | -------------------------------- | ------------------------------------------------ |
| `user_id`   | `uuid` PK `→ users(id) CASCADE`  | one row per user, because it **is** the PK        |
| `autosave`  | `boolean NOT NULL DEFAULT true`  |                                                  |
| `theme`     | `text NOT NULL DEFAULT 'system'` + `settings_theme_check` (`theme IN ('system','light','dark')`) | |
| `updated_at`| `timestamptz NOT NULL DEFAULT now()` |                                               |

PR-07 inserts the row with the user; PR-09's `settings.service.get()` get-or-creates so the invariant survives
a user row created by a fixture or a future import path.

### `auth_attempts`

| Column      | Type                                    | Notes                                                     |
| ----------- | --------------------------------------- | --------------------------------------------------------- |
| `id`        | `uuid` PK                                |                                                            |
| `user_key`  | `text NOT NULL`                          | `lower(username)`, or an IP for an unknown user — failures against a non-existent account are still recorded |
| `succeeded` | `boolean NOT NULL`                       | only failures count against the lockout (PR-07)            |
| `at`        | `timestamptz NOT NULL DEFAULT now()`     | written by the caller; `between` filters are bound as timestamp parameters |

Append-only, never cascaded (it has no `user_id`), and pruned by the maintenance cron in PR-07 — which is what
`auth_attempts_key_at_idx` exists for.

## 3. The root, and why the sibling indexes use `COALESCE`

A plain unique index over a nullable column does not exist for `NULL`: `UNIQUE (user_id, parent_id, name)`
would allow an unlimited number of identically-named root folders. Both sibling indexes therefore coalesce the
nullable parent to the nil UUID:

```sql
CREATE UNIQUE INDEX folders_unique_sib ON folders (user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE UNIQUE INDEX notes_unique_sib   ON notes   (user_id, COALESCE(folder_id,  '00000000-0000-0000-0000-000000000000'::uuid), name);
```

so the root is one more level and collides like anything else. `src/db/schema.int.test.ts` asserts the index
definitions and the violation itself, in the root and inside a folder; `folders_unique_sib` is deferred while
drizzle-kit builds an index, which is also why the migration is ordered the way it is.

Cycle prevention is **not** a database constraint (Postgres has no recursive CHECK) and is **not** a
read-then-write in PR-04. PR-09 owns it: `move`/`rename` run in a transaction that FIRST takes
`pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))` — one lock per user, serializing
that user's create/move/delete — and then walks ancestors. Locking only the two affected rows is not enough:
two moves can lock disjoint pairs (X→Y and Z→W), each pass its own ancestor walk, and commit a cycle.
`isDescendantOrSelf()` in `folders.repo.ts` is the ancestor walk that check will use.

## 4. The optimistic-locking contract (PR-10's 409)

`writeNoteContent()` in `notes.repo.ts` is one statement, not a read-modify-write:

```sql
UPDATE notes
   SET version = version + 1, content_cipher = …, content_iv = …, key_version = …,
       content_bytes = …, word_count = …, content_updated_at = …, updated_at = …
 WHERE id = $1 AND version = $2 AND user_id = $3
 RETURNING <the whole row>
```

- Zero rows back means the caller's `baseVersion` is stale, or the note is gone, or it belongs to someone else;
  the repository returns `undefined` and **PR-10 renders that as `409`**. It is deliberately not an exception:
  a conflict is a normal answer here, not a bug.
- The row comes back whole, so the new `version` is available to return to the client without a second query
  (and no window between the two).
- `version` is bumped **only** by a content write. `renameNote` and `moveNote` touch `name`/`folder_id` and
  `updated_at` and leave `version` alone, so renaming or re-filing a note never invalidates an open editor.
- Two writers that read the same version: exactly one wins, asserted concurrently in
  `notes.repo.int.test.ts`. Nothing is merged and nothing is lost silently.
- The key rotation (PR-06's `apps/server/src/scripts/rotate-note-key.ts`) is the only other writer of these
  columns, and it is deliberately **not** a content write:

  ```sql
  UPDATE notes SET content_cipher = …, content_iv = …, key_version = $current, updated_at = now()
   WHERE id = $1 AND version = $2 AND key_version = $old
  ```

  It never bumps `version` (that would push every open tab's autosave into a 409) and never touches
  `content_updated_at` (that would reshuffle the recents list), yet it still carries `version` in its `WHERE`
  for the reason this section exists: zero rows back means someone edited the note in the meantime, and the
  rotation re-reads the row rather than writing the ciphertext it had already buffered. Each batch is one
  transaction that starts `SELECT … FOR UPDATE`, so the read and the reseal are atomic against the app.

## 5. Error contract

The database is the layer that decides these, and the services map them. Note where the code actually is:
drizzle-orm catches the driver's error and rethrows its own `DbError`/`DrizzleQueryError`, so **the SQLSTATE is
on `error.cause.code`**, not on the thrown error. Reading `error.code` returns `undefined`, which is how a
constraint you forgot to map becomes a 500. `apps/server/src/test/helpers/pg-error.ts` walks the `cause` chain
for the tests, and is the shape the services layer should follow.

| SQLSTATE | Means                                                              | Rendered as (PR-07/09/10) |
| -------- | ------------------------------------------------------------------ | ------------------------- |
| `23505`  | unique violation — `users_username_lower_uidx`, `users_one_owner_uidx`, `folders_unique_sib`, `notes_unique_sib` | `409` (or `422` for a username that is taken) |
| `23503`  | foreign key failed — a `folder_id`/`user_id` that is not there       | `400` (a UI that cannot send this is fine) |
| `23514`  | CHECK violated — empty name, a role outside `(owner, member)`, a theme outside the three | `400` |
| `22P02`  | invalid input syntax for a `uuid` (a malformed id in the route)      | `400` |
| `22001`  | value too long                                                       | `413` for note content, `400` otherwise |

`constraint_name` (postgres.js v4 spellings; `constraint` in some drivers) says *which* index fired and is what
lets `23505` distinguish "username taken" from "folder name taken". It goes in the log, never in a response
body: `/api/health` is unauthenticated and PR-18's `HEALTHCHECK` polls it from outside the container.

## 6. Coverage of the invariants

From plan §4/§8, and where each is now **proven** rather than asserted:

| Invariant | Where it is enforced | Proof |
| --- | --- | --- |
| Username unique case-insensitively | `users_username_lower_uidx` on `lower(username)` | `schema.int.test.ts` (definition + `Kayla`/`kayla` → `23505`) |
| Exactly one owner | `users_one_owner_uidx` (partial unique on `role = 'owner'`) | `schema.int.test.ts` (a second explicit `role='owner'` insert → `23505` from that constraint) |
| A role-less insert is never an owner | column `DEFAULT 'member'` | `schema.int.test.ts` (two raw role-less inserts coexist, both `member`) |
| One name per `(user, folder)`, root included | `folders_unique_sib` / `notes_unique_sib` + `COALESCE` | `folders.repo.int.test.ts`, `notes.repo.int.test.ts` (inside a folder **and** at the root) |
| Two users may use the same name in the same place | `user_id` is the first index column | `folders.repo.int.test.ts` |
| Deleting a folder deletes its subtree, notes included | `ON DELETE CASCADE` on `parent_id`/`folder_id` | `folders.repo.int.test.ts` (three levels deep, one note two levels down) |
| Deleting a user deletes everything they own | `ON DELETE CASCADE` on every `user_id` | `folders.repo.int.test.ts` (other user's rows survive, so the zeros mean something) |
| A content write to a stale `version` writes nothing | `WHERE id AND version AND user_id RETURNING` | `notes.repo.int.test.ts` (stale write → `undefined`, row unchanged; three-way race → one winner) |
| Cross-user reads return nothing | every repository statement filters by `user_id` | both repository tests, on every read and write |
| `word_count` / `content_bytes` / `content_updated_at` always exist | `NOT NULL DEFAULT 0/now()` | `schema.int.test.ts` (defaults present) + `notes.repo.int.test.ts` (an insert without them) |
| Ciphertext is never plaintext | no plaintext column, flag or code path; `crypto/envelope.ts` is the only writer (PR-06) | the column list above; `notes.repo.int.test.ts` round-trips bytes that are not valid UTF-8; `crypto/envelope.test.ts` (a flipped byte, a foreign key, or another row's AAD throws rather than yielding blank content) |
| A key rotation never overwrites a concurrent edit | `rotate-note-key.ts`: one transaction per batch, `SELECT … FOR UPDATE`, `WHERE id AND version AND key_version`, and it never bumps `version` | `rotate-note-key.int.test.ts` (the autosave wins, `version` incremented exactly once, `--verify` exits 0 afterwards) |
| One `settings` row per user | `user_id` is the PK | `schema.int.test.ts` (the fixture's two users get one row each) |
| An install has an owner before anyone joins | `users_one_owner_uidx` here + service guards in PR-07 | as above |

## 7. How the schema is built and checked

- `drizzle-orm` and `drizzle-kit` are pinned to exact versions in `apps/server/package.json`, and `postgres` is
  pinned too because **PR-19 declares the same `postgres` version as a devDependency of `apps/web`** for its
  e2e DB reader.
- **The migration is generated, not hand-written**: `pnpm db:generate` (drizzle-kit) writes the SQL and the
  journal, and both are committed. Postgres 16 is the CI and compose version; `timestamptz` everywhere.
- One statement in the first migration is hand-added, before the generated block:
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;`. drizzle-orm 0.45 has no way to declare a public-schema extension
  in `schema.ts`, so §8 of the plan's SQL cannot be fully generated; the statement is the smallest honest
  bridge, and `schema.int.test.ts` asserts it lands. **Everything below it is generated output**: drizzle-kit
  stores a hash of each applied file in `drizzle.__drizzle_migrations`, so a post-apply rewrite fails every
  later `db:migrate`.
- `pnpm db:migrate` / `pnpm db:generate` carry `NODE_ENV=development` on their own command line, which is what
  lets `drizzle.config.ts` (and the Vitest setup file) call `loadDevEnvFile()`; drizzle-kit and Vitest never
  import `env.ts` on their own. A bare `pnpm exec drizzle-kit generate` with no mode fails the same way the app
  would, which is intended.
- The DSN always comes from `databaseUrl()` in `env.ts`: a set `DATABASE_URL` is used verbatim (CI exports it),
  otherwise it is composed from `POSTGRES_*`, so flipping `POSTGRES_PORT` in `.env` moves the container and
  every host process together. No second DSN builder exists.
- `pnpm test:integration` / `pnpm coverage:integration` declare `NODE_ENV=test` and are the only commands that
  touch a database; `vitest.integration.config.ts` is the only Vitest config that reads the DSN, and
  `src/test/setup.ts` applies the committed migration before the first test and fails fast when no database
  answers. Test files never run concurrently (one database, `resetDb()` in `beforeEach`); concurrency *inside*
  a test is used on purpose for the race assertions.
- `migrateDatabase()` (`src/db/migrate.ts`) runs **at boot, before `listen()`**, so `docker compose up` on a fresh volume serves nothing until the schema exists —
  including `GET /api/health`, which PR-18's `HEALTHCHECK` polls. It is a no-op when the database is already at
  the latest migration, and it reports `{ total, applied }`.
- CI: the `integration` job in `.github/workflows/CI.yml` runs a `postgres:16` service, exports
  `DATABASE_URL`, runs `pnpm test:integration` then `pnpm coverage:integration`, and uploads
  `coverage-integration/`. The `apps/server/src/db` ≥ 80% lines threshold lives in
  `vitest.integration.config.ts` — never in a CI flag.
- `make db-up` / `db-down` / `db-reset` are the Postgres lifecycle (dev Postgres 16 in Docker);
  `make bootstrap-env` only creates `.env` from `.env.example`, which ships dev defaults and deliberately **no
  `DATABASE_URL`**.

## 8. Known as-built deviations

- `pgcrypto` is created but unused by the MVP: ids come from `newId()` in the application, not
  `gen_random_uuid()`. It is there because plan §8 asks for it and because operators debugging a production
  database expect it.
- `newId()` wraps `v7` from **`uuid`**, not the `@uuidjs/uuid-v7` that plan §8 and MVP-04 §4/§5 name. That
  scoped package has never existed — `https://registry.npmjs.org/@uuidjs%2fuuid-v7` answers 404 — and `uuid` is
  the uuidjs project itself, which exports `v7` from its public entry point. PR-04 shipped `uuid` and corrected
  both documents to say so; nothing else in the plan depends on the scoped name.
- `notes.word_count` is **whatever the caller that sealed the ciphertext supplies**; the database neither stores
  nor computes the plaintext, so it cannot tokenise anything. PR-12's preview needs a count, not a dictionary,
  and a later PR that wants different tokenisation changes the caller rather than the column.
- There is no `email` column (the account name is the username) and no trash column (deletes are hard, §1).
- `updated_at` has no database trigger (§1).
- `auth_attempts.at` has a server-side `DEFAULT now()` but is always written explicitly by the caller, so a
  test can place an attempt on either side of the lockout window.
