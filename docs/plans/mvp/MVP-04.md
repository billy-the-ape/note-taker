# MVP-04 · PR-04 — DB schema, migrations, repository harness

> **Task ID:** `PR-04` · **Branch:** `feat/pr-04-db-schema` · **Size:** L (3–4 days) · **Depends on:** PR-01, PR-02 (merged)
> **Track:** B Data · **Review gate:** feeds M1/M2 · **Unblocks:** PR-06, PR-07, PR-09, PR-19 (driver version)

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~26k tokens** | this brief (4.6k as written, incl. the verbatim schema you must reproduce) + PR-01's `env.ts` and PR-02's `Makefile`/`.env.example` + drizzle-orm/postgres.js/drizzle-kit docs + Vitest workspace config + re-reading failing integration output |
| **Output** | **~13k tokens** | `db/schema.ts` (~180 lines), `db/client.ts`, `db/migrate.ts`, `drizzle.config.ts`, two repositories + their `.int.test.ts`, `test/{helpers/db.ts,helpers/app.ts,fixtures.ts}`, generated SQL migration, `vitest.integration.config.ts`, `docs/DATA-MODEL.md`, root/CI script edits |
| **Session total** | **~39k tokens** | ≈ one `L` engineer-day; budget ~55k with two integration-debug loops (the migration idempotence + advisory-lock assertions are the fiddly parts) |

> 1 token ≈ 4 chars; ±30%. Generated `migrations/*.sql` counts as output even though drizzle-kit writes it.

---

## 1. Goal

The data layer: a real Postgres schema (single source of truth in Drizzle), committed SQL migrations, a programmatic
migration runner wired into the server bootstrap, a repository harness, and a test harness with a real DB — plus the
`integration` job in CI. **No HTTP routes, no auth, no crypto.**

## 2. Repo state you can assume (PR-01 + PR-02 merged)

- `apps/server/src/env.ts` exports `loadDevEnvFile()` and **`databaseUrl()`** (the single DSN resolver: a set
  `DATABASE_URL` is used verbatim; unset + `NODE_ENV=development|test` ⇒ composed from `POSTGRES_*` with host
  `localhost`; unset + `production` ⇒ hard failure; a `POSTGRES_*` value containing `@ : / + % ? #` fails naming the
  variable). **Reuse it — do not build a second DSN.**
- Scripts that read env declare their mode inline (`NODE_ENV=development tsx watch src/index.ts`). That is the contract
  this PR now implements for `db:*` and `test:integration`.
- `docker/compose.dev.yml` (Postgres 16-alpine, `${POSTGRES_PORT:-5432}` published) + `make db-up/db-down/db-reset`
  with `bootstrap-env`; `.env.example` has `NODE_ENV`, `POSTGRES_*`, `HOST_PORT`, and **no** `DATABASE_URL`.
- Unit Vitest configs already `exclude: ['**/*.int.test.ts']`, so the suffix split is pre-configured.
- CI has `quality`, `unit`, `build` jobs (PR-03) — **you add the `integration` job here**.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-04`; CI green; never lower a coverage threshold; every new DB column
ships with a generated migration **in the same PR**; docs it invalidates are updated here (`docs/DATA-MODEL.md` is
created by this PR; `AGENTS.md` gains `make db-*`/`pnpm db:generate|db:migrate|test:integration` if it lists commands);
no secrets, only dev defaults.

## 4. The schema (reproduce exactly; it is the contract PR-06/07/09/10 build on)

UUID PKs — **UUIDv7 preferred**: one `newId()` helper wrapping `@uuidjs/uuid-v7`; Node's `crypto.randomUUID()` (v4) is
an acceptable fallback because nothing in the MVP orders rows by id. Either way there is **exactly one `newId()`** and
every insert goes through it.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() fallback for defaults

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  username          text NOT NULL,                       -- compared case-insensitively via unique index
  password_hash     text NOT NULL,                       -- argon2id encoded string
  display_name      text,
  role              text NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner','member')),   -- LEAST-privilege on purpose: with the one-owner index
                                                          -- below, an insert that forgets the column must never mint
                                                          -- an owner (a second such row would die on that index).
                                                          -- Only /setup writes 'owner', explicitly.
  password_set_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
-- Exactly one owner, enforced by the DB instead of a read-then-insert race: a second concurrent /setup attempt hits
-- this index and gets CONFLICT, so two owners are impossible even under a race. Owned by PR-04's schema; PR-07's
-- acceptance includes the concurrent-setup test. This index is also why the column default above is 'member': a
-- DEFAULT 'owner' would turn every role-less insert (fixtures, register, POST /api/users) into an owner attempt.
-- Services still pass `role` explicitly and never lean on the default.
CREATE UNIQUE INDEX users_one_owner_uidx ON users (role) WHERE role = 'owner';

CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY,                        -- sha256(session_token); raw token only in the cookie
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE folders (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = root. The cycle check (PR-09) runs in a
      -- transaction that FIRST takes pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text)): one
      -- lock per user serializes folder create/move/delete. Locking only the two affected rows is NOT enough: two
      -- moves can lock disjoint pairs (X→Y and Z→W), each pass its own ancestor walk, and commit a cycle.
  name       text NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX folders_unique_sib ON folders (user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX folders_user_parent_idx ON folders(user_id, parent_id);

CREATE TABLE notes (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id          uuid REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = root (mirrors folders.parent_id)
  name               text NOT NULL CHECK (name <> ''),    -- WITHOUT the ".md" suffix
  version            integer NOT NULL DEFAULT 1,          -- bumped on every content write (optimistic concurrency)
  content_cipher     bytea NOT NULL,                      -- AES-256-GCM ciphertext || 16-byte tag; NEVER a plain-text default
  content_iv         bytea NOT NULL,                      -- 12 bytes, per-write random (no default: empty IV is undecryptable)
  key_version        integer NOT NULL DEFAULT 1,
  content_format     text NOT NULL DEFAULT 'markdown',
  content_bytes      integer NOT NULL DEFAULT 0,          -- plaintext byte length (for listings, no decrypt)
  word_count         integer NOT NULL DEFAULT 0,
  content_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notes_unique_sib ON notes (user_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX notes_user_folder_idx ON notes(user_id, folder_id);
CREATE INDEX notes_user_content_updated_idx ON notes(user_id, content_updated_at DESC);  -- "recent notes"

CREATE TABLE settings (   -- 1 row per user, inserted in the SAME transaction as the users row (PR-07);
                          -- settings.service.get() get-or-creates as the belt for rows made outside it
                          -- (PR-04 fixtures, seeds, restores). No trigger exists in this schema.
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  autosave   boolean NOT NULL DEFAULT true,
  theme      text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_attempts (          -- durable rate-limit / lockout evidence (PR-07)
  id        uuid PRIMARY KEY,
  user_key  text NOT NULL,            -- lower(username) or ip
  succeeded boolean NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key_at_idx ON auth_attempts(user_key, at DESC);
```

### Invariants this schema must make impossible (verify the ones with no code yet)

| Invariant | Enforcement |
| --- | --- |
| Every folder/note belongs to exactly one user | `user_id NOT NULL` + `WHERE user_id = auth.userId` in **every repository query**; cross-user access ⇒ `404`, never `403`. Note the FKs do **not** carry `user_id`, so PR-09's services must scope-load target folders. |
| Sibling names unique (case-sensitive, trimmed, no `/`, no control chars, ≤ 120 chars) | DB unique index (here) + Zod refinements (PR-05) |
| Note name never stores the `.md` extension | `stripMd()` in `contracts/names.ts` (PR-05), applied in `note.service.ts` (PR-09) |
| A folder cannot be moved inside itself | PR-09 CTE ancestor walk inside the per-user advisory lock |
| `note.version` monotonic | conditional `UPDATE … WHERE id=$1 AND version=$2 RETURNING` ⇒ 0 rows ⇒ 409 (assert the statement's shape here) |
| Deleting a folder removes descendants | `ON DELETE CASCADE`, gated by `?cascade=true` in the API |
| Notes **and** folders may live at the root | `notes.folder_id`/`folders.parent_id` nullable, `NULL` = root; the `COALESCE` unique indexes keep root sibling names unique |
| Note content is never plaintext, in any environment | `crypto/envelope.ts` is the only writer (PR-06); **there is no plaintext column, flag, or code path** |
| Every user has exactly one `settings` row | `user_id` is the PK; PR-07 inserts it with the user; PR-09's `settings.service.get()` get-or-creates |
| The install has an owner before anyone else joins | `users_one_owner_uidx` (here) + service guards (PR-07) |

No soft-delete/trash (backlog PR-23): deletes are hard, guarded by a typed confirmation dialog later.

## 5. Files to create / modify

**Create**

- `apps/server/drizzle.config.ts` — **must call `loadDevEnvFile()` then `databaseUrl()` at the top**: drizzle-kit never
  imports `env.ts` on its own.
- `apps/server/src/db/schema.ts` — every table + index above (the single source of truth).
- `apps/server/src/db/client.ts` — postgres.js pool (`DB_POOL_MAX`) + drizzle instance, DSN from `databaseUrl()`.
- `apps/server/src/db/migrate.ts` — programmatic migration runner; **wire into `index.ts` bootstrap before `listen()`**
  (plan §6: "migrations run at container start before `listen()`"; PR-18's entrypoint is only `exec node …`).
- `apps/server/migrations/` — committed SQL generated by `drizzle-kit generate` (+ the journal).
- `apps/server/src/db/repositories/folders.repo.ts`, `notes.repo.ts` — **harness form**. The notes repo stores
  **opaque** `content_cipher` / `content_iv` / `key_version` triples supplied by its caller: it never sees plaintext, because
  the schema has no plaintext representation. Its tests insert fixed test blobs; PR-06 plugs the real
  `crypto/envelope.ts` in behind the same interface.
- `apps/server/src/db/repositories/*.int.test.ts` — every DB-backed file carries the `.int.` suffix (plan §14's split rule).
- `apps/server/src/test/helpers/db.ts` — spin/truncate against `DATABASE_URL`; truncate in dependency-safe order
  between tests (transaction-per-test or truncate-all fixture).
- `apps/server/src/test/helpers/app.ts` — `withApp()` building the Fastify app via `buildApp()` + `app.inject()` (never
  binds a port).
- `apps/server/src/test/fixtures.ts` — creates users with raw schema inserts (the auth-shaped `users.repo.ts` /
  `sessions.repo.ts` come in PR-07). It needs **two** users for cross-user cases: one `role='owner'`, one
  `role='member'`, **both written explicitly** — a fixture that omits `role` twice under the one-owner index is an
  accident waiting to collide rather than a test.
- `apps/server/vitest.integration.config.ts` — `include: ['src/**/*.int.test.ts']`; **the only config that reads
  `DATABASE_URL`**; its Vitest **setup file must call `loadDevEnvFile()` + `databaseUrl()`** (Vitest does not import
  `env.ts` on its own).
- `docs/DATA-MODEL.md` — the schema, the indexes, and the invariants table above, as-built.

**Modify**

- Root + `apps/server` `package.json` scripts, per PR-01's inline-mode rule:
  `db:generate` = `NODE_ENV=development drizzle-kit generate`, `db:migrate` = `NODE_ENV=development drizzle-kit migrate`,
  `test:integration` / `coverage:integration` = `NODE_ENV=test vitest run --config vitest.integration.config.ts`
  (`coverage:integration` adds `--coverage`), plus root passthroughs.
  Without the inline `NODE_ENV` these commands hit the missing-`NODE_ENV` failure or run with the loader disabled, and
  the acceptance below cannot pass.
- `apps/server/package.json` deps: `drizzle-orm`, `postgres`, `@uuidjs/uuid-v7`; dev: `drizzle-kit`,
  `@vitest/coverage-v8`. Pin the `postgres` version — **PR-19 declares the same version as a devDependency of
  `apps/web`** for its e2e DB reader.
- `apps/server/src/index.ts` — call the migration runner before `listen()`.
- `.github/workflows/CI.yml` — add the `integration` job: `services: postgres:16` with `POSTGRES_PASSWORD: test` and an
  exported `DATABASE_URL`, then `pnpm build:packages && pnpm test:integration`, **plus the `pnpm coverage:integration`
  step** that produces the DB-dependent coverage numbers and uploads `coverage-integration/`. This is the PR that makes
  that job meaningful.

## 6. CI/coverage facts you must respect

- Coverage thresholds live in the Vitest config that produces the number, never in CI flags.
- Row armed by this PR: `apps/server/src/db` **≥ 80% lines**, enforced by **`pnpm coverage:integration`** in the
  `integration` job (these files are only exercised against a real DB). Later rows for `{services,db,routes}` reach 85%
  only after PR-19 ratchets the thresholds.
- Two coverage commands, each owned by the job that can run it: `pnpm coverage` = unit configs, no DB;
  `pnpm coverage:integration` = the integration config with `--coverage` inside the `integration` job.
- Determinism rules: truncate in dependency-safe order between tests; `vi.useFakeTimers()` for time-dependent unit
  tests; **no test touches the network**.

## 7. Acceptance criteria

- [ ] `pnpm db:generate && pnpm db:migrate` idempotent on a fresh **and** an existing DB — run from a shell with nothing
      exported: `env -u NODE_ENV -u DATABASE_URL -u POSTGRES_USER … pnpm db:migrate` (or `env -i` with only `PATH`),
      against the repo-root `.env` a cold clone has (`cp .env.example .env`, which ships `POSTGRES_*`/`HOST_PORT` and no
      `DATABASE_URL`). It succeeds **only because** the script contributes `NODE_ENV=development`.
- [ ] **The negative half matters:** running the tool without the script —
      `env -u NODE_ENV pnpm exec drizzle-kit migrate` (pnpm injects no `NODE_ENV` of its own) — must exit **non-zero**
      with the missing-`NODE_ENV` message. Without this pair, a future edit that drops the inline mode silently disables
      `loadDevEnvFile()` and the block above goes vacuously green.
- [ ] (a) Flip `POSTGRES_PORT` in the repo-root `.env` (and recreate the dev `db`): `pnpm db:migrate` follows it —
      true only because `databaseUrl()` derives the DSN from `POSTGRES_*` when `DATABASE_URL` is unset.
- [ ] (b) Put a literal `DATABASE_URL=…:5433/notetaker_test` in the same `.env`: the same command targets **that**
      string verbatim (`process.loadEnvFile` performs no `${VAR}` expansion) — which is also how the CI job's exported
      `DATABASE_URL` wins.
- [ ] Integration tests prove (≥ 15 assertions): sibling uniqueness for folders and notes; **root-level rows work**
      (`folders.parent_id IS NULL`, `notes.folder_id IS NULL` insert; two root notes with the same name collide; a root
      note and a note inside a folder do **not**); cascade delete of nested folders; the `notes.version` conditional
      update returns **0 rows** on a stale `baseVersion`; cross-user select returns nothing; **`users_one_owner_uidx`
      rejects a second `role='owner'` row** (a raw two-row insert that states `role` raises a unique violation) — the
      invariant PR-07's setup-race test relies on, proven at the schema layer where it lives; and the plan §8 default itself:
      a raw insert that omits `role` lands as `'member'`, so two role-less fixture users coexist and neither is an owner.
- [ ] `GET /api/health` still green (`db` may stay static `'ok'` until you wire the pool — wiring it here is welcome but
      keep it cheap), and `pnpm test` / the `unit` job stay green with zero Postgres.
- [ ] `pnpm coverage:integration` meets the `apps/server/src/db` ≥ 80% lines row.

## 8. Out of scope

HTTP routes, auth, argon2, encryption/crypto, seeding (`scripts/seed-demo.ts` is PR-09), search, `pg_trgm`/`tsvector`.

## 9. PR body template

```
Task: PR-04

## What
Drizzle schema (users/sessions/folders/notes/settings/auth_attempts + all indexes), committed migrations, postgres.js
client + programmatic migrate wired before listen(), folders/notes repositories (opaque ciphertext triples), test
harness (withDb/withApp/fixtures: one owner + one member), vitest.integration.config.ts, docs/DATA-MODEL.md,
db:generate/db:migrate/test:integration/coverage:integration scripts, CI integration job.

## Acceptance evidence
- env-cleared `pnpm db:migrate` twice (idempotent) + `env -u NODE_ENV pnpm exec drizzle-kit migrate` → non-zero
- POSTGRES_PORT flip followed; literal DATABASE_URL honored verbatim
- integration run summary (≥15 assertions) + coverage:integration ≥80% on src/db
```
