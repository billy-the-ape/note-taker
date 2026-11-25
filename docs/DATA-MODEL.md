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
| Repositories   | `apps/server/src/db/repositories/{folders,notes,settings,users}.repo.ts`      |
| Services       | `apps/server/src/services/{tree,folder,note,settings,auth}.service.ts` — the only layer that decides a status code |
| Proof          | `apps/server/src/**/*.int.test.ts`, run only by `pnpm test:integration` (PR-04 `db/`, PR-07 auth, PR-09 `services/`, `routes/` and `scripts/`) |

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

*As-built* (PR-07): `password_hash` is written by `auth/passwords.ts` (argon2id, one random salt per
password) and replaced only through `setUserPassword()`, the single statement that also moves
`password_set_at` — the only evidence after the fact that a credential was rotated. The one supported
recovery path is `apps/server/src/scripts/reset-password.ts`, which updates those two columns and `DELETE`s
that user's `sessions` rows **in one transaction** (there is no state in which the password changed and the
sessions survived), and touches nothing else: every other `user_id` foreign key in this file is
`ON DELETE CASCADE`, so "delete the account and create it again" is data destruction followed by a
`POST /api/auth/setup` that answers `409` forever. `src/scripts/reset-password.int.test.ts` runs the script
as a subprocess and asserts the notes, folders and settings of the account are still there afterwards.

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

PR-07 inserts the row with the user; PR-09 makes that survive a user created by any other path. Both
`settings.service.get()` and `settings.service.patch()` start with `ensureSettingsRow()` — `INSERT … ON CONFLICT
(user_id) DO NOTHING`, so two first calls race and one of them is *the success case* — and then read or update the
row. A user whose row was never written therefore has exactly one row after either call, never a `404`, and never
the zero-row write that a bare `UPDATE` would report as success; `services/settings.service.int.test.ts` and
`routes/settings.routes.int.test.ts` assert both halves against a row deleted on purpose. `updated_at` is read
back from the database rather than assumed, so the timestamp a client is told about is the one the row carries.

### `auth_attempts`

| Column      | Type                                    | Notes                                                     |
| ----------- | --------------------------------------- | --------------------------------------------------------- |
| `id`        | `uuid` PK                                |                                                            |
| `user_key`  | `text NOT NULL`                          | `lower(username)` — the key even when no such account exists, so a probe against a name nobody owns is still recorded. A username containing `U+0000` cannot be stored (`text` refuses it, SQLSTATE 22021), so `attemptKey` writes U+FFFD in its place; no real account can collide with that, because `usernameSchema` is `[a-z0-9._-]` (PR-07) |
| `succeeded` | `boolean NOT NULL`                       | the outcome, for the audit trail. The rate window does not read this column: `http/rate-limit.ts` charges every login *attempt* as it arrives and clears the window on a success (PR-07) |
| `at`        | `timestamptz NOT NULL DEFAULT now()`     | written by the caller; `between` filters are bound as timestamp parameters |

Append-only, never cascaded (it has no `user_id`). PR-07 writes a row for every credential outcome it is asked
about — each login attempt, either answer, and each self-sign-up whose username was already taken — and none for
a request a rate window refused, on either endpoint: a blocked client would otherwise grow this table for free.

**Nothing ever deletes these rows, and no retention or prune job is planned for the MVP.** That is the honest
state: `MVP-FULL-PLAN.md` contains no such job (§16's configuration reference has no knob for it, and PR-20 is the
documentation pass, not an operations one) — a grep of `docs/plans/mvp` for `prune`/`retention` finds only Docker's
*pruned install*. An earlier sentence here promised a "maintenance cron in PR-20" that does not exist, which is the
kind of pointer that makes a reader trust a table that was never written. As of PR-07 the table is written and never
read; `auth_attempts_key_at_idx (user_key, at desc)` exists for the reader an operator query or a lockout report
would need, and it is what a future prune would use to find its rows. Growth is one row per credential check on a
single-instance box, so this is a deliberate non-feature rather than an emergency; whoever adds a rule should put the
`DELETE` next to `recordAuthAttempt` in `apps/server/src/db/repositories/auth-attempts.repo.ts`, whose header says the
same thing from the code side, and ship it with the reader that needs the space back rather than as a background job
an operator has to remember to enable.

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

Both indexes are checked **per statement**, which is what makes a rename-and-move a single statement rather than
two: `patchNote` and `patchFolder` write the name and the parent column in one `UPDATE`, so the row is judged by
the `(parent, name)` the request asked for. Renaming first and re-parenting afterwards puts the row in the
position *half* the request described while the index is deciding — a legal `PATCH {name, parentId}` refused for a
clash in the folder the row was leaving — and a second statement that fails after the first committed leaves
exactly that half applied with nothing to tell the client which it was. Proven at statement level in
`folders.repo.int.test.ts` and `notes.repo.int.test.ts` ("renames and moves in one statement"), and at the wire in
`routes/notes.routes.int.test.ts`.

Cycle prevention is **not** a database constraint (Postgres has no recursive CHECK), and it is not a
read-then-write either. PR-09 owns it, as-built: `create`, `move` and `delete` in `services/folder.service.ts`
each run in one transaction that FIRST takes
`pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))` — `takeFolderMoveLock()` in
`folders.repo.ts`, one lock **per user**, which serializes every folder mutation of that user and nothing else —
and only then walks ancestors.

Locking only the two affected rows is not enough: two moves can lock disjoint pairs (`X→Y` and `Z→W`), each pass
its own ancestor walk, and commit a four-node cycle. `isDescendantOrSelf()` (the upward walk from a proposed
parent) is the check, and it is only correct because the lock guarantees nobody is re-parenting underneath it
while it runs. `services/folder.service.int.test.ts` asserts both interleavings — the adjacent pair that a
row-lock design also survives, and the disjoint pair that it does not.

Two more things the same transaction decides, both because the tree is data and not a cache:

* **The 100-level cap is arithmetic on the database's depths, not on a client's breadcrumb.** A create compares
  `folderDepth(parent)` against the cap; a move compares `folderDepth(destination) + 1 + folderSubtreeHeight(moving)`,
  where the height is the longest path *below* the folder being moved. The second term is what makes a move of a
  deep subtree under a root refuse with `VALIDATION` naming the cap, when a destination-depth check alone would
  have waved it through. Nothing is truncated, ever.
* **The cascade is the schema's, and the refusal is the service's.** `deleteFolder()` is one `DELETE` over
  `(id, user_id)`; the descendant folders and the notes inside them go because `parent_id`/`folder_id` are
  `ON DELETE CASCADE` (§2) — there is no delete-then-recurse in JavaScript, and therefore no state where a folder
  is gone and its children are not. What the API adds is the *gate*: without `?cascade=true` the service locks the
  folder row first (`lockFolderRow()`, `FOR UPDATE`) and **only then** counts direct children
  (`countChildren()`) and the notes in this folder (`countNotesInFolder()`), refusing a non-empty one with
  `409 CONFLICT`, because a recursive delete the user did not ask for is data destruction.
  The row lock is not decoration, and the per-user advisory lock above does not provide it: a note `INSERT` takes
  `KEY SHARE` on the folder row it points at, and `FOR UPDATE` conflicts with that. Count first and the answer can
  be "empty" about a folder someone is writing into right now, and the later `DELETE` waits on the very same
  `KEY SHARE` only after the gate has already opened — then cascading over the row that won the race, so the client
  is told `204` for a delete that destroyed a note whose `POST` it was told had succeeded a moment earlier. Locking
  first makes the count read a snapshot that includes the committed insert (→ `409`); an insert that starts
  afterwards blocks on this lock and dies on its foreign key once the delete commits (→ `404` for the folder).
  Asserted concurrently in `services/folder.service.int.test.ts`, next to the cycle-race tests that share the file.
* **One read serves the whole tree.** `listFolderTree()` is a single recursive CTE over the caller's rows that
  returns folders flat with their `depth` and a root-first `path` breadcrumb (walk metadata: `folderNodeSchema`
  has no path field, and PR-12 rebuilds the nesting from `parentId`), ordered by `name collate "C", id` so the
  answer is the same on a `C` and an `en_US.utf8` cluster, and `listNotesForTree()` supplies the notes beside
  them. The walk's guard is `depth < ${TREE_WALK_GUARD}` (100) — one more than the deepest folder the cap allows,
  so a legal tree is never truncated — and `tree.service.int.test.ts` renders a 99-deep chain to prove the
  difference between a guard and a fence. There is no stored depth column: a materialised depth would be a second
  truth for a move to get wrong.
* **A raw statement's columns are read, never asserted.** This CTE is the only application code that reads SQL
  drizzle cannot express, and a raw result carries **no column metadata**: the first CI run answered every
  `GET /api/tree` with `500`, because the mapping wrote `row.created_at as Date` and the driver — which had no way
  to know the column was ever a `timestamptz` — handed back text for `.toISOString()` to choke on. The statement
  therefore asks for one unambiguous JS reading of the two timestamps
  (`floor(extract(epoch from …) * 1000)::bigint` — `floor`, because `numeric::bigint` rounds and a JavaScript date
  parse truncates, and the two must agree to the millisecond),
  and the values pass through `rawTimestamp()` / `rawTextArray()` in `db/rows.ts`, which tolerate the shapes a
  driver may actually deliver — a `Date`, an integer, the integer as text, ISO or Postgres text; a JS array or the
  array literal Postgres writes (`{"Top","Mid"}`, escapes and all) — and throw rather than invent `1970-01-01`.
  `db/rows.test.ts` pins the parser and `folders.repo.int.test.ts` pins the row, so the next raw statement (PR-11's
  search is the likely candidate) has two things to copy and one mistake not to repeat.

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
  the repository returns `undefined` and **PR-10 renders that as a `404` or a `VERSION_CONFLICT`** — never as one
  or the other on a guess. The statement filtered on `user_id`, so the two cases are the same answer at SQL level;
  what separates them is one scoped `SELECT` afterwards, and answering `409` for a row the caller does not own
  would confirm the row exists *and* hand over its decrypted body. That payload is deliberate: `data.content` and
  `data.version` are the current server state, which PR-14's autosave compares with the exact snapshot it put on
  the wire, so a write that committed but whose reply went missing is adopted instead of reported as a collision.
- A second precondition sits above this one, in the transport: `PUT …/content` accepts an optional `If-Match`, and
  a header naming a version other than the one being written against is answered from that same scoped re-read
  without any write at all. There is no `412` in this API's nine codes, so a violated precondition is a
  `VERSION_CONFLICT` (or the `404` the re-read says is true) rather than a status no client has a recovery for.
- The row comes back whole, so the new `version` is available to return to the client without a second query
  (and no window between the two).
- `version` is bumped **only** by a content write. `patchNote` and `patchFolder` — the one statement behind each
  `PATCH` — touch `name`/`folder_id`/`parent_id` and `updated_at` and leave `version` alone, so renaming or
  re-filing a row never invalidates an open editor.
- Two writers that read the same version: exactly one wins, asserted concurrently in
  `notes.repo.int.test.ts`, and again one layer up (through the HTTP endpoint, with a request cancelled while it
  waits on the row lock) in `notes.content-race.int.test.ts`. Nothing is merged and nothing is lost silently.
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
constraint you forgot to map becomes a 500. `apps/server/src/db/pg-error.ts` (PR-07) is the production reader —
`isUniqueViolation()` and `constraintOf()` — and `apps/server/src/test/helpers/pg-error.ts` is its twin for the
tests, which cannot import it because that file imports `expect` from Vitest.

| SQLSTATE | Means                                                              | Rendered as (PR-07/09/10) |
| -------- | ------------------------------------------------------------------ | ------------------------- |
| `23505`  | unique violation — `users_username_lower_uidx`, `users_one_owner_uidx`, `folders_unique_sib`, `notes_unique_sib` | `409 CONFLICT` for all four, as of PR-07: plan §9.1's code list has no `422`, and "that username is taken" and "this install already has an owner" are the same statement to a client — the constraint name that tells them apart goes in the log, not in a new status code |
| `23503`  | foreign key failed — a `folder_id`/`parent_id` that is not there     | `404 NOT_FOUND` (PR-09). Every id that arrives in a **body** is looked up scoped to the caller before anything is written, so this only fires when the parent is deleted between that check and the insert — which is exactly the answer the same request would have given a moment earlier. A `500` here would be a lie about who broke, and a `400` would be a new code for a state a client can only reach by racing itself |
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
| Exactly one owner | `users_one_owner_uidx` (partial unique on `role = 'owner'`) | `schema.int.test.ts` (a second explicit `role='owner'` insert → `23505` from that constraint); the concurrent-`/setup` race is `routes/auth.routes.int.test.ts` (three simultaneous setups → one `200`, two `409`, one owner row) |
| A role-less insert is never an owner | column `DEFAULT 'member'` | `schema.int.test.ts` (two raw role-less inserts coexist, both `member`) |
| One name per `(user, folder)`, root included | `folders_unique_sib` / `notes_unique_sib` + `COALESCE`, and one `UPDATE` per `PATCH` (§3) so the index never judges a half-applied rename-and-move | `folders.repo.int.test.ts`, `notes.repo.int.test.ts` (inside a folder **and** at the root; and a rename+move whose new name is free at the destination but taken at the source, which two statements refused) |
| Two users may use the same name in the same place | `user_id` is the first index column | `folders.repo.int.test.ts` |
| Deleting a folder deletes its subtree, notes included | `ON DELETE CASCADE` on `parent_id`/`folder_id` | `folders.repo.int.test.ts` (three levels deep, one note two levels down) |
| Deleting a user deletes everything they own | `ON DELETE CASCADE` on every `user_id` | `folders.repo.int.test.ts` (other user's rows survive, so the zeros mean something) |
| A content write to a stale `version` writes nothing | `WHERE id AND version AND user_id RETURNING` | `notes.repo.int.test.ts` (stale write → `undefined`, row unchanged; three-way race → one winner) |
| Cross-user reads return nothing | every repository statement filters by `user_id` | both repository tests, on every read and write |
| `word_count` / `content_bytes` / `content_updated_at` always exist | `NOT NULL DEFAULT 0/now()` | `schema.int.test.ts` (defaults present) + `notes.repo.int.test.ts` (an insert without them) |
| Ciphertext is never plaintext | no plaintext column, flag or code path; `crypto/envelope.ts` is the only writer (PR-06) | the column list above; `notes.repo.int.test.ts` round-trips bytes that are not valid UTF-8; `crypto/envelope.test.ts` (a flipped byte, a foreign key, or another row's AAD throws rather than yielding blank content) |
| A key rotation never overwrites a concurrent edit | `rotate-note-key.ts`: one transaction per batch, `SELECT … FOR UPDATE`, `WHERE id AND version AND key_version`, and it never bumps `version` | `rotate-note-key.int.test.ts` (the autosave wins, `version` incremented exactly once, `--verify` exits 0 afterwards) |
| One `settings` row per user, in the user's own transaction | `user_id` is the PK, and `insertUserWithSettings()` is the only writer that pairs them | `schema.int.test.ts` (the fixture's two users get one row each); `users.repo.int.test.ts` (a transaction aborted between the two inserts leaves neither row) |
| A password change changes the password and revokes the other devices together | one transaction in `auth.service.ts` — `setUserPassword`, `deleteSessionsOfUser` and `rotateSessionToken` all run on the caller's `tx` | `services/auth.service.int.test.ts` (a change whose last statement fails leaves the old hash and both sessions exactly as they were, and still refuses with the service's own `401`) |
| An install has an owner before anyone joins | `users_one_owner_uidx` here + `auth.service.ts`'s two guards | `routes/registration.int.test.ts` (`POST /api/auth/register` answers `403` on an empty database even with `ALLOW_REGISTRATION=true`, and `needsSetup` stays `true`) |
| A folder move never creates a cycle | per-user `pg_advisory_xact_lock` + the ancestor walk inside it (§3) | `services/folder.service.int.test.ts` — the adjacent pair started as siblings (one commits, one `409`) and the four-node disjoint-pair race that a row-lock design commits a cycle through; afterwards the tree walk terminates and both folders stay reachable |
| A delete without `?cascade=true` never destroys a note that was created beside it | `lockFolderRow()` — the folder row's `FOR UPDATE`, taken **before** the emptiness counts (§3), which conflicts with the `KEY SHARE` a note insert takes on the parent row | `services/folder.service.int.test.ts` (a note create and a non-cascade delete of the same folder at once: either the folder survives with its note, or the create is refused for a folder that is gone — never a `204` over a note whose `201` was already acknowledged) |
| A **generated** note name never answers `409` | `note.service.ts` re-picks the name when the insert loses `notes_unique_sib` (`GENERATED_NAME_ATTEMPTS`); a name the client typed still clashes, on purpose | `services/note.service.int.test.ts` (four nameless creates at one pinned clock, started together: four rows, four distinct names, no conflict — where the sequential pair test cannot see the race at all) |
| The tree is at most 100 levels, and a tree that legal is never truncated | the service's cap on create (`folderDepth`) and on move (`destination depth + 1 + subtree height`); no DB constraint can express it | `services/folder.service.int.test.ts` (the 101st level refuses, naming the cap; a deep subtree under a root refuses too) and `services/tree.service.int.test.ts` (a 99-deep chain renders complete, with a note at the bottom) |
| A raw statement's columns are read through a helper, never asserted as a type | `db/rows.ts` — `rawRows()`, `rawTimestamp()`, `rawTextArray()` — with the tree CTE asking for `epoch … ::bigint` and the array literal read as written (§3), because a raw result carries no column metadata | `db/rows.test.ts` (each shape a driver may deliver, and a throw rather than an invented `1970-01-01`) + `folders.repo.int.test.ts` (the walked row: depth, breadcrumb, and timestamps equal to the row that was inserted) — this is the assertion PR-09's first CI run was missing, when every `GET /api/tree` answered `500` |
| An id in a **body** is the caller's or the answer is `404` | `folderById`/`noteById` scoped to `userId` before any insert or update, so the FK never fires (§5's `23503` row) | `routes/cross-user.int.test.ts` — the four-call matrix (note create, folder create, folder move, note move) against another user's folder, all four envelopes byte-identical to a nonexistent id, and both trees byte-identical afterwards |
| A note body never crosses the tree wire | `treeResponseSchema` has no `content`, and `tree.service.ts` maps every row through `toNoteNode()`, which is the one place the cipher/iv/key-version columns are dropped | `services/tree.service.int.test.ts` + `routes/tree.routes.int.test.ts` (the payload is parsed, then searched for a `content` key) |
| A stored body that will not authenticate is an error, never an empty note | `crypto/envelope.ts` throws; `mapError` renders `INTERNAL` and logs the note id (§5) | `routes/notes.routes.int.test.ts` (the blob is rewritten directly, then `GET /api/notes/:id` answers 500 with no `content` field), `plugins/error-handler.test.ts` (nothing about key versions on the wire) |
| One `settings` row survives a user whose row was never written | `ensureSettingsRow()` before every read and patch (§2) | `services/settings.service.int.test.ts`, `routes/settings.routes.int.test.ts` (defaults with `200`, one row left behind, read back by a second `GET`, and a `PATCH` on the zero-row user updates exactly one) |
| The demo seed is safe to run twice | lookup-by-`(user, parent, name)` then insert, never truncate-and-reseed; `main()` refuses `NODE_ENV=production` before it opens a pool | `scripts/seed-demo.int.test.ts` (second run creates 0 and reports the same counts, an edited body and an added folder are left alone, every seeded body opens with the app keyring) |

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
  `coverage-integration/`. The `apps/server/src/{db,services,routes}` ≥ 80% thresholds — `db` armed by PR-04 and
  widened to the services and routes by PR-09 — live in
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
