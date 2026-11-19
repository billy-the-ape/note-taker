# MVP-18 · PR-18 — Production Docker image + compose + env safety + deploy docs

> **Task ID:** `PR-18` · **Branch:** `feat/pr-18-docker-prod` · **Size:** M (1–2 days)
> **Depends on:** PR-01…PR-17 (the whole app — PR-17 closes M3). The image can be drafted as early as PR-12 and rebased.
> **Track:** F Ship · **Unblocks:** PR-19 (e2e runs the built app), PR-20
> **Owns:** `docs/DEPLOY.md`, the `docker build` step in CI, `scripts/check-env.ts`, and the operator runbook rules.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~27k tokens** | this brief (5.2k as written: the runbook, config table and drill commands you must reproduce) + PR-01's `env.ts` + PR-05's contracts resolution story + PR-06's keyring/rotation script + PR-07's reset script + PR-12's `static-spa` path + Docker Compose interpolation semantics + long container log excerpts |
| **Output** | **~11k tokens** | `docker/Dockerfile`, `docker/compose.yml`, `docker/entrypoint.sh`, `scripts/check-env.ts`, `docs/DEPLOY.md` (the longest file), root `check:env` script, the CI `docker build` step, `.env.example` prod additions |
| **Session total** | **~38k tokens** | ≈ one `M` engineer-day; budget ~50k — the restore drill and the two env-preflight paths are where iterations happen |

> 1 token ≈ 4 chars; ±30%. Wall-clock (image builds, clean-VM drill) dominates; token cost is mostly log reading.

---

## 1. Goal

`docker compose --env-file .env -f docker/compose.yml up -d` on a clean VM gives a healthy app on **one published port**,
with migrations run inside the compiled Node bootstrap, a Node-based healthcheck, an env preflight, and a `docs/DEPLOY.md`
whose every command was actually executed (backup/restore, key rotation, password reset).

## 2. Repo state you can assume (PR-01…PR-17 merged)

- pnpm monorepo; `pnpm build` builds `packages/contracts` to `dist/` (its `package.json` `exports`/`main`/`types` point
  at `./dist` only — no source aliasing anywhere) and then the apps. The server is compiled by `tsc` to
  `apps/server/dist` (which includes `dist/scripts/rotate-note-key.js` from PR-06 and `dist/scripts/reset-password.js`
  from PR-07); the web SPA builds to `apps/web/dist`; PR-12's `plugins/static-spa.ts` serves the SPA from the API port.
- `apps/server/src/env.ts` is the compiled boot guard, `db/migrate.ts` runs migrations before `listen()`.
- CI has `quality`, `unit`, `build` (pnpm build), `integration` (Postgres service, `test:integration`,
  `coverage:integration`) jobs — **no `docker build` and no `e2e` yet**.
- `docker/compose.dev.yml` (PR-02) already establishes the `--env-file .env -f …` convention.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-18`; CI green; never lower a coverage threshold; docs updated in the
same PR (`docs/DEPLOY.md` is created here; `README.md`/`AGENTS.md` gain the `check:env` + `make`-equivalent commands if
they list them).

## 4. Configuration reference (the table your `check-env.ts` and `DEPLOY.md` must match)

| Var | Default | Prod required | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | **none — required**: `development`/`test`/`production` | ✔ `production` | selects the invariant set enforced by the compiled `env.ts`; unset fails everywhere. **Nobody hand-sets it in production:** the image bakes `ENV NODE_ENV=production` into stage 2 and `compose.yml` repeats it in the `app` service `environment:` block. Locally/in CI it comes from the **script line**, never from the shell or from reading the file |
| `HOST` | `0.0.0.0` | — | bind address |
| `PORT` | `3000` | — | port the **container** listens on; `compose.yml` pins it to 3000 so `EXPOSE`/`HEALTHCHECK` stay valid |
| `HOST_PORT` | `3000` | — | host side of the single published mapping — the operator-facing port knob |
| `POSTGRES_USER` | `notetaker` | ✔ **in `.env` whenever compose is used** | role created by the `db` service; the runbook's shell commands read it, so it must be written into `.env` (Compose's `${VAR:-notetaker}` covers Compose interpolation only) |
| `POSTGRES_PASSWORD` | `notetaker` | ✔ for the compose stack | the only secret the `db` container needs. **Must be URL-safe** — generate with `openssl rand -hex 32`: both DSN compositions embed it **raw** and nothing percent-encodes, so `@ : / + % ? #` silently corrupts the URL |
| `POSTGRES_DB` | `notetaker` | ✔ **in `.env` whenever compose is used** | db created on first init; interpolated into the app's DSN; also the base for the restore drill's `<db>_restore` |
| `POSTGRES_PORT` | `5432` | — | **dev-only** — appears solely in `docker/compose.dev.yml`; the prod `db` publishes nothing |
| `DATABASE_URL` | **unset ⇒ derived** (`postgres://<user>:<pw>@localhost:<port>/<db>` on the host); **set ⇒ verbatim** | ✔ **required in `production`** (in the process) | do **not** set it in the compose stack: `compose.yml` derives it in the `app` service `environment:` block (which beats `env_file:`) with host `db`. `.env.example` ships **no** `DATABASE_URL` line. The one place a runbook sets it explicitly is the restore drill (`run -e DATABASE_URL=…`) |
| `DB_POOL_MAX` | `10` | — | postgres.js pool size |
| `SESSION_TTL_DAYS` | `30` | — | session cookie + DB expiry (> 365 refused in prod) |
| `SECURE_COOKIES` | `false` | ✔ `true` behind TLS | `Secure` flag; refused `false` when `TRUST_PROXY=true` or registration is open |
| `TRUST_PROXY` | `false` | ✔ if behind a proxy | accurate client IPs for rate limiting |
| `ALLOW_REGISTRATION` | `false` | — | opens `POST /api/auth/register` |
| `NOTE_ENCRYPTION_KEY` | — | ✔ (32 bytes base64) | current AES-256 key |
| `NOTE_ENCRYPTION_KEY_FILE` | — | alternative to the key var | key read from a mounted file by `crypto/keys.ts` at boot |
| `NOTE_ENCRYPTION_KEY_PREVIOUS` | — | only during rotation | JSON map `{"1": "<base64>"}` of **older** keys; written **single-quoted** in `.env`: Compose strips one quote layer for the container, while the runbook sources the same file in a shell where unquoted JSON is a syntax error |
| `NOTE_ENCRYPTION_KEY_VERSION` | `1` | ✔ set alongside the key | the integer tag stamped into `notes.key_version` for the **current** key; explicit, never derived; bumped by hand, rewritten by `rotate-note-key.js` |
| `LOGIN_RATE_LIMIT_MAX` | `10` | — | failures per 15 min per user+IP |
| `MAX_NOTE_BYTES` | `1048576` | — | body / note size cap |
| `LOG_LEVEL` | `info` | — | pino level |
| `DOTENV_PATH` | `<repo root>/.env` | — | override for the file `loadDevEnvFile()` reads (dev/test) **and** for `scripts/check-env.ts`, which runs in production mode and reads it as data; tests point it at a fixture |
| `APP_NAME` | `Note Taker` | — | SPA title |

## 5. Files to create

### `docker/Dockerfile`

- Stage 1: build all workspaces with dev deps + `pnpm build` (so contracts' `dist/` exists before the apps compile).
- Stage 2: `node:22-slim`, **`ENV NODE_ENV=production`** (the runtime image is production by construction — nobody has to
  remember it), pruned install via `pnpm deploy --prod` (or `npm ci --omit=dev`) that must carry **the compiled
  `packages/contracts`** (its `package.json` + `dist/`, reached through `exports`) so the server's
  `@note-taker/contracts` import resolves to JS and never to `src/*.ts`.
- Copy `dist` (including `dist/scripts/` — how the operator scripts ship) and `migrations`; copy `apps/web/dist` into the
  server's static path. `USER node`, `EXPOSE 3000`, no build toolchain in the runtime layer.
- `ENTRYPOINT` → `docker/entrypoint.sh`, which is **only** `exec node apps/server/dist/index.js`. No `pnpm`, no `tsx`, no
  `.ts` execution in the runtime layer. **Env checks and migrations run inside the compiled Node bootstrap**
  (`env.ts` + `db/migrate.ts`). `scripts/check-env.ts` stays a dev/CI convenience whose rules are enforced at boot by the
  compiled `env.ts`.
- `HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3` with **no `curl`** (`node:22-slim` ships none,
  and installing it in the runtime layer is out of scope):
  `CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.

### `docker/compose.yml`

- `db` + `app`. `db`: `postgres:16`, named `pgdata` volume, `pg_isready` healthcheck, **no published port**.
- `app`: `depends_on: {db: {condition: service_healthy}}`, `env_file: ../.env` (so the container's environment doesn't
  depend on the shell), `restart: unless-stopped`, `init: true`, `ports: ["${HOST_PORT:-3000}:3000"]`.
- `app.environment:` sets `NODE_ENV=production`, `PORT=3000` (pinned, so `EXPOSE`/`HEALTHCHECK` stay true while
  `HOST_PORT` moves the host side),
  `DATABASE_URL: postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB` (**raw** interpolation; host is the
  service name `db`, never `localhost`), and
  `NOTE_ENCRYPTION_KEY: ${NOTE_ENCRYPTION_KEY:?set NOTE_ENCRYPTION_KEY in the repo-root .env}` — required, no default, so
  `docker compose config` fails at parse time naming the variable instead of handing the container an empty key. That is
  what makes the runbook's toolchain-free preflight real. (The mounted-key-file variant is an explicit edit to this file:
  volume + `NOTE_ENCRYPTION_KEY_FILE`, and removing the `:?` line, because Compose interpolation cannot express
  either/or.)
- Optional `notes-keys` volume for a mounted key file.

### `scripts/check-env.ts` — a linter, not a boot path

Wired as the root **`check:env`** script: `NODE_ENV=production tsx scripts/check-env.ts` (PR-01's inline-mode rule). It
reads `process.env.DOTENV_PATH ?? <repo root>/.env` **as text with its own parser** and validates it against the prod
rules. Routing it through `loadDevEnvFile()` would be wrong twice over: the loader is a no-op in `production` by design,
and a preflight must see the operator's file whether or not the shell already exports those keys.

Its one rule that cannot be copied verbatim from the boot guard is the DSN: the **guard** fails an unset **process**
`DATABASE_URL` (right, because Compose has already composed it), while the **linter** sees only the **file**, where the
documented prod `.env` carries the `POSTGRES_*` trio and deliberately no DSN. So the linter accepts **either** form, fails
only on a file that has neither, and warns when both are present and disagree. It also applies the URL-safety check
(`[A-Za-z0-9]+` in practice) to the `POSTGRES_*` trio in the file. Without that carve-out the runbook's own `.env` could
never pass its own preflight.

### `docs/DEPLOY.md`

Must contain, with commands **exactly as written here**: how to invoke compose with the env file, the one-port mapping,
TLS/reverse-proxy recipe (documented, not implemented), backups (`pg_dump` + the **key**), the restore drill, the
key-rotation procedure, the upgrade procedure, the password-recovery command, and a troubleshooting table.

## 6. The runbook your docs must reproduce

**Why the flags are mandatory:** Compose resolves its project directory from the compose file's location, so with
`-f docker/compose.yml` it auto-loads `.env` from `docker/`, **not** the repo root. Always run from the repo root with
**both** flags. `docs/DEPLOY.md` and the Makefile must use the identical invocation.

```bash
# 1. generate config in the REPO ROOT
printf 'NOTE_ENCRYPTION_KEY=%s\n' "$(docker run --rm node:22-slim node -e \
  'console.log(require("crypto").randomBytes(32).toString("base64"))')" > .env
# 2. fill in POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD (+ optionally HOST_PORT). All three are REQUIRED in the
#    file (Compose's ${VAR:-notetaker} default is invisible to a sourced shell, so an omitted one expands to empty).
#    POSTGRES_PASSWORD must be URL-safe: openssl rand -hex 32.
# 2b. preflight with Docker alone (this host may have no Node at all):
docker compose --env-file .env -f docker/compose.yml config >/dev/null   # fails naming NOTE_ENCRYPTION_KEY
#    Then:
docker compose --env-file .env -f docker/compose.yml up -d     # publishes ONLY ${HOST_PORT:-3000}
docker compose --env-file .env -f docker/compose.yml ps        # app reported healthy
# 3. open http://<host>:<HOST_PORT> → /setup → create the first owner
```

**Operator shell convention:** `set -a; . ./.env; set +a` **first** — `--env-file` feeds Compose's interpolation only and
never populates the shell. **Never hardcode `notetaker`** in these commands; use `"$POSTGRES_USER"` / `"$POSTGRES_DB"`.
Optional belt: `: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"` after sourcing.

**Backups:** `docker compose --env-file .env -f docker/compose.yml exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" |
gzip > "backup-$(date +%F).sql.gz"` — **`-T` is mandatory** (`docker compose exec` allocates a TTY by default, which
CRLF-translates the dump and corrupts it) — **plus the encryption key** (`.env`, the mounted key file, or `.dev/note-key`
in dev).

**Restore drill (four ordered steps; the scratch DB must exist before anything is piped into it):**

1. `docker compose --env-file .env -f docker/compose.yml exec -T db createdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"`
   — never over the live `$POSTGRES_DB`; do **not** try the "rename `POSTGRES_DB`" route (the postgres image reads
   `POSTGRES_DB` only while initializing an **empty** data directory).
2. `gunzip -c backup-<date>.sql.gz | docker compose --env-file .env -f docker/compose.yml exec -T db psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" -v ON_ERROR_STOP=1`
3. `docker compose --env-file .env -f docker/compose.yml run -d --rm --name restore-drill -p 127.0.0.1:3100:3000 -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/${POSTGRES_DB}_restore" app`
   — `compose run` **publishes none of the service's `ports:`** by default, so the port must be mapped explicitly with
   `-p`, and it must run **detached** because step 4 needs it alive; use the **same** `NOTE_ENCRYPTION_KEY` or every note
   decrypts to garbage. Confirm the override with `docker exec restore-drill printenv DATABASE_URL` — note the **plain
   `docker`** CLI: `docker compose exec`/`stop` take a **service** name, so `docker compose exec restore-drill …` fails and
   `docker compose stop app` would take the **live** app down mid-drill.
4. open `http://127.0.0.1:3100`, log in, read a note back; then `docker stop restore-drill` (plain `docker`; `--rm`
   removes it); then `docker compose --env-file .env -f docker/compose.yml exec -T db dropdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"`.

The drill must consume exactly the artifact the backup step produces (`gzip` included) — an ungzipped or TTY-corrupted
dump failing at step 2 is the point.

**Key rotation (six steps):** (1) back up first; (2) edit the repo-root `.env` **by hand** — append the old key to
`NOTE_ENCRYPTION_KEY_PREVIOUS` as `{"<old version>": "<old base64>"}`, set the new `NOTE_ENCRYPTION_KEY`, bump
`NOTE_ENCRYPTION_KEY_VERSION` to `<old>+1`, writing that line **single-quoted**
(`NOTE_ENCRYPTION_KEY_PREVIOUS='{"1": "sGx/…="}'`) so sourcing the file stays valid; the JSON must contain no single
quotes of its own; (3) `up -d` so the app picks up the new keyring; (4)
`… exec app node apps/server/dist/scripts/rotate-note-key.js --dry-run`, then the same without `--dry-run` (the app is
live and autosaving: the script locks each batch's rows `FOR UPDATE` and writes conditionally, so a save landing
mid-rotation is never overwritten); (5) `… --verify` ⇒ exit 0 means every row is on the current version and decrypts;
(6) only then may the old entry leave `_PREVIOUS`.

**Password recovery:** `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/reset-password.js <username>`
(PR-07) — changes the hash and that user's sessions and nothing else. **Never** delete a `users` row to "reset" an
account: the `user_id` FKs cascade over sessions/folders/notes/settings, and `POST /api/auth/setup` stays blocked while an
owner row exists.

**Updates:** `git pull && docker compose --env-file .env -f docker/compose.yml build && docker compose --env-file .env -f docker/compose.yml up -d`
— the Node bootstrap runs migrations before `listen()`, so **migrations must be backward-compatible within one minor
release** (a documented rule).

## 7. Acceptance criteria

- [ ] `docker compose --env-file .env -f docker/compose.yml up -d` on a clean VM → the `app` container reaches `healthy`
      (`docker inspect --format '{{.State.Health.Status}}' app…`) — this proves the Node `HEALTHCHECK` works with no
      `curl` in the image.
- [ ] `curl http://localhost:3000/api/healthz` ok **from the host**; a browser on `:3000` reaches `/setup`, creates the
      account, and CRUD survives `docker compose … restart`.
- [ ] `HOST_PORT=8080` in the repo-root `.env` ⇒ the app answers on `:8080` and nothing listens on `:3000` (proves the
      mapping under test; `PORT` stays pinned to 3000 inside the container).
- [ ] `docker compose --env-file .env -f docker/compose.yml exec app node -e "console.log(process.env.NODE_ENV)"`
      prints `production` **with no `NODE_ENV` entry in `.env`** — the image/compose set it, and the boot guard is
      therefore armed (an unset value would exit non-zero at boot and never reach `healthy`).
- [ ] `docker history` shows no dev deps and no `curl`; the container runs as uid ≠ 0.
- [ ] Boot fails loudly (non-zero) when `NOTE_ENCRYPTION_KEY` is missing in production.
- [ ] On that same clean VM, with nothing but Docker: `docker compose --env-file .env -f docker/compose.yml config`
      exits non-zero **naming the variable without creating a single container**.
- [ ] The dev/CI form is asserted **in the CI `build` job** (where the repo toolchain exists, never from the runbook):
      `pnpm check:env` — defined as `NODE_ENV=production tsx scripts/check-env.ts` — run against **two fixture files**
      through `DOTENV_PATH` (not the runner's own environment): exits non-zero listing the same missing variables
      **before Docker is contacted**, then exits 0 once `NOTE_ENCRYPTION_KEY` is filled in. Two details make the exit-0
      reachable and are asserted explicitly: the fixture `.env` has **no `NODE_ENV` entry** and **no `DATABASE_URL`
      line** (the trio satisfies the DSN rule). A third assertion pins the negative case: a file with **neither** form
      exits non-zero naming both options.
- [ ] **Operator drills, all executed inside the built image:** the backup + restore drill **each numbered step in order**
      (scratch DB created first, `-T` on every piped command, `run -d … -p 127.0.0.1:3100:3000 -e DATABASE_URL=…`,
      plain `docker exec`/`docker stop` for the one-off container, every command after `set -a; . ./.env; set +a`, against
      a `.env` carrying **all three** `POSTGRES_*` values); the key-rotation drill (edit `.env`, `up -d`, `--dry-run` →
      real run → `--verify` exits 0, and a note written **before** the rotation still opens in the browser); and
      `reset-password.js <username>` letting that user log in again with their folders, notes and settings untouched.
- [ ] **If either script needs something the image lacks** (pnpm, `tsx`, a `.ts` entry, a published DB port), the fix is
      to move it under `apps/server/src/scripts/` and re-run — **not** to add dev tooling to stage 2.
- [ ] CI: `docker build` **step** added to the `build` job (never pushes an image — no registry in the MVP).

## 8. Out of scope

Kubernetes manifests, TLS termination (documented only), image registry publishing, backup automation/cron (backlog
PR-30), metrics/tracing, `.dev/note-key` handling outside what PR-06 already does.

## 9. PR body template

```
Task: PR-18

## What
docker/Dockerfile (multi-stage, node:22-slim, ENV NODE_ENV=production, USER node, Node-fetch HEALTHCHECK, compiled
contracts in the pruned install), docker/compose.yml (db+app, one published port, ${NOTE_ENCRYPTION_KEY:?…}, derived
DATABASE_URL), docker/entrypoint.sh (exec node only), scripts/check-env.ts + pnpm check:env, docs/DEPLOY.md,
CI docker build step.

## Acceptance evidence (clean VM)
- up -d → healthy → curl :3000/api/healthz → HOST_PORT=8080 honored
- compose config with a key-less .env → non-zero naming the var, no containers created
- pnpm check:env against the two DOTENV_PATH fixtures (fail → fill key → pass; trio-only file passes; neither-form file fails)
- transcripts: backup → createdb → psql restore → run -d restore-drill → read note at :3100 → docker stop → dropdb
- transcripts: rotation --dry-run → run → --verify 0 → pre-rotation note opens; reset-password restores login
- docker history (no dev deps, no curl) + uid != 0
```
