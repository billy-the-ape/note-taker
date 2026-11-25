# Deploy

Note Taker ships as two containers and one published port. This is the operator runbook, and it is the
deploy-side contract of PR-18: the commands here are the commands `docker/compose.yml` and
`docker/Dockerfile` take, in the order they run. The Compose-level ones — the preflight, the interpolation,
the one-port mapping, the §3 edit — are asserted by CI on every pull request (`.github/workflows/CI.yml`,
`build` job) against this very file; `pnpm check:env`'s two fixtures are asserted in the same job. The
container-execution sections (§5–§8) are the drill to run on the host, in order, and they are PR-18's
acceptance runbook: a step that does not behave as written here is a bug in this file, and this file is the
thing under review.

* The image: [`docker/Dockerfile`](../docker/Dockerfile) — multi-stage, `node:22-slim`, `ENV
  NODE_ENV=production`, `USER node`, a Node `fetch` healthcheck, and the compiled
  `@note-taker/contracts` inside the pruned install.
* The stack: [`docker/compose.yml`](../docker/compose.yml) — `db` + `app`, one published port, a derived
  DSN, and a required `NOTE_ENCRYPTION_KEY`.
* The preflight: `pnpm check:env` — [`.env.example`](../.env.example) is the template,
  §4 below is the reference it enforces.

There is no registry: nothing in this repository pushes an image. You build it on the host that runs it.

| § | About |
| --- | --- |
| [§1](#1-the-invocation) | The two flags, and the one port |
| [§2](#2-first-deploy) | Clean host → first owner account |
| [§3](#3-the-mounted-key-file-variant) | The key in a file instead of in `.env` |
| [§4](#4-configuration-reference) | Every variable, its default, and what it is for |
| [§5](#5-backups) | `pg_dump` — plus the key, which is the part people forget |
| [§6](#6-the-restore-drill) | Proving a backup is restorable, while it is still a backup |
| [§7](#7-key-rotation) | Rotating the note-encryption key without downtime |
| [§8](#8-updates-restarts-tls-and-password-recovery) | Upgrades, TLS in front, forgotten password |
| [§9](#9-troubleshooting) | What breaks, and what it says when it does |

---

## 1. The invocation

```bash
docker compose --env-file .env -f docker/compose.yml <up|ps|logs|exec|run|config|…>
```

**Both flags, always, from the repo root.** Compose resolves its *project directory* from the compose file's
location, so `docker compose -f docker/compose.yml …` on its own auto-loads `.env` from `docker/` — not from
the repo root where the file lives — and a `--env-file` path that does not exist is a hard error before
Docker is contacted at all. The same rule the `Makefile` pins for the dev database (PR-02); `make prod-up`,
`make prod-ps`, `make prod-logs`, `make prod-build` and `make prod-config` are this command behind an
interface, and no target silently creates `.env` for you in production (see §2).

`up -d` starts Postgres 16 and the app; `down` stops them and keeps the volume.

**One port.** The stack publishes exactly `"${HOST_PORT:-3000}:3000"`. The database publishes **nothing**:
the app reaches it as the service name `db` over the Compose network, and that is the only route to it —
which is why every database command below is `docker compose exec -T db …` and never `psql -h localhost`.
Inside the container `PORT` is pinned to `3000` by `compose.yml`, so `EXPOSE 3000` and the image's
healthcheck stay truthful no matter what `HOST_PORT` is set to; `HOST_PORT` moves only the host side.

```bash
# the whole mapping, from the repo root, once:
docker compose --env-file .env -f docker/compose.yml up -d
```

### The operator shell convention

`--env-file .env` populates Compose's interpolation and the containers' environment. It does **not**
populate the shell you are typing in — so any command below that uses `"$POSTGRES_USER"`, `"$POSTGRES_DB"`
or the key needs the file sourced first:

```bash
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"   # optional belt: fail loud, not silent
```

`set -a` marks every variable it reads for export, so the runbook's tools see them too. **Never hardcode
`notetaker`** in an operator command: use `"$POSTGRES_USER"` and `"$POSTGRES_DB"`, and let that belt turn a
missing line into an error instead of a `pg_dump` against the wrong database. This is also why §2 writes all
three `POSTGRES_*` values into `.env`: Compose's `${POSTGRES_USER:-notetaker}` default is invisible to a
sourced shell, where an omitted variable expands to empty.

---

## 2. First deploy

Prerequisite: a host with Docker (and the Compose v2 plugin). Nothing else — not Node, not pnpm, not a
Postgres client. Everything that needs a toolchain runs inside the image, and the image builds them itself.

```bash
git clone https://github.com/billy-the-ape/note-taker && cd note-taker
```

**1. Generate the configuration in the repo root.** One variable, from a container, on the target host:

```bash
printf 'NOTE_ENCRYPTION_KEY=%s\n' "$(docker run --rm node:22-slim node -e \
  'console.log(require("crypto").randomBytes(32).toString("base64"))')" > .env
```

(`openssl rand -base64 32` is equally valid. The point is that the key is created here, once, and never
travels through a chat message — see §5 for why losing it is unrecoverable.)

**2. Add the database identity** — edit `.env` and add all three:

```bash
{
  echo 'POSTGRES_USER=notetaker'
  echo 'POSTGRES_DB=notetaker'
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
} >> .env
```

*All three are **required in the file**, not merely defaulted.* Compose interpolates them into both the `db`
container and the app's DSN, and the runbook's shell reads them for `pg_dump` (§5).
`POSTGRES_PASSWORD` **must be URL-safe** — generate it with `openssl rand -hex 32`: both DSN compositions
embed it **raw** and nothing percent-encodes on the way, so `@ : / + % ? #` silently corrupts the URL and
the app connects somewhere else, or nowhere. **`pnpm check:env` is the only thing that checks this**, and it is
optional: `env.ts` refuses those characters where it *derives* a DSN (`dsnComponent()`, i.e. development and
test), while inside this stack Compose hands it a composed one and it is used verbatim — nothing at boot
re-inspects a password that has already become a URL. So run the preflight in step 2b; the alternative is
discovering a bad password as a connection failure (§9). Add `HOST_PORT=8080` too if you do not want `:3000`
(see step 5).

**2b. Preflight, with Docker alone** (this host may still have no Node):

```bash
docker compose --env-file .env -f docker/compose.yml config >/dev/null   # fails naming NOTE_ENCRYPTION_KEY
```

…is the check that the stack is deployable. Delete the key line from a copy of `.env` and run it again:
Compose fails at **parse** time, **naming the variable**, and creates **no container** — because
`compose.yml` declares `NOTE_ENCRYPTION_KEY` as required-without-default instead of defaulting it to empty.
A key that is silently empty is worse than one that is missing: it boots, encrypts notes with a key nobody
configured, and produces bodies that decrypt to nothing.

If you *do* have the repository's toolchain on this host (a build machine, or a staging box), also run the
preflight that judges the file rather than the process:

```bash
pnpm install && pnpm check:env
```

It reads `DOTENV_PATH ?? <repo root>/.env` **as text** and applies the §4 rules — `NODE_ENV` and
`DATABASE_URL` are the two lines it wants *absent*, and it never contacts Docker or a database. It is a
linter, not a boot path: the container's real guard is the compiled `apps/server/src/env.ts`, which runs on
every boot.

**3. Start it.**

```bash
docker compose --env-file .env -f docker/compose.yml up -d     # publishes ONLY ${HOST_PORT:-3000}
docker compose --env-file .env -f docker/compose.yml ps        # app reported healthy
```

`up -d` builds the image on first run (several minutes: it installs the workspace twice — once with dev
dependencies to build, once without to run — and compiles all three workspaces), then applies the committed
migrations **inside the app**, before it binds the port. There is no migration container and no
`db:migrate` step to forget; see §8 for what that implies for upgrades.

`ps` printing `healthy` is the interesting column: that status comes from the image's `HEALTHCHECK`, which
is a `node -e` with `fetch` — `node:22-slim` ships no `curl`, and installing a download tool into a runtime
layer to ask one question is not worth it:

```bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose --env-file .env \
  -f docker/compose.yml ps -q app)"
```

**4. Create the owner.** Open `http://<host>:<HOST_PORT>` → `/setup` → create the first owner. That is the
only door: `ALLOW_REGISTRATION` is `false` by default, and `/setup` closes behind its first owner.

**5. Verify what this file claims.** Each of these is the acceptance check for a paragraph above it. Source the
file first (§1): step 2 may have written `HOST_PORT=8080`, and an unsourced `${HOST_PORT:-3000}` curls `:3000`
and reports a failure that does not exist.

```bash
set -a; . ./.env; set +a                    # §1: --env-file fills Compose's interpolation, not this shell
curl -fsS "http://localhost:${HOST_PORT:-3000}/api/healthz"                     # ok from the host
docker compose --env-file .env -f docker/compose.yml exec app \
  node -e "console.log(process.env.NODE_ENV)"                                   # production
docker compose --env-file .env -f docker/compose.yml exec app id -u              # not 0
docker history --no-trunc "$(docker compose --env-file .env -f docker/compose.yml images -q app)" \
  | grep -E 'curl|tsx|typescript|vitest' && echo 'LEAK' || echo 'runtime layer clean'
```

`NODE_ENV` printing `production` with **no `NODE_ENV` entry in `.env`** is the whole configuration story in
one line: the image bakes `ENV NODE_ENV=production` and `compose.yml` repeats it in the app service, so the
mode cannot be missing — and because `env.ts` requires the variable and never defaults it, a container that
somehow lost it would exit non-zero at boot instead of quietly booting in development mode (which is the
mode where the production invariants are *off*).

Then prove the mapping, since `PORT` is pinned and `HOST_PORT` is not:

```bash
printf 'HOST_PORT=8080\n' >> .env
docker compose --env-file .env -f docker/compose.yml up -d
curl -fsS http://localhost:8080/api/healthz                 # answers here…
curl -fsS http://localhost:3000/api/healthz && echo 'UNEXPECTED' || echo 'nothing on :3000'
docker compose --env-file .env -f docker/compose.yml exec app \
  node -e "console.log(process.env.PORT)"                   # still 3000 inside
```

---

## 3. The mounted key file variant

By default the key lives in `.env`. The alternative is `NOTE_ENCRYPTION_KEY_FILE`, which the keyring reads at
boot through `readNoteEncryptionKey()` in `apps/server/src/env.ts`, so the key never appears in a shell, in
`docker inspect`, or in a file someone might commit.

**0. Take the key into this shell before anything else**, because piece 3 deletes it from `.env` and the writer
below reads it from stdin:

```bash
set -a; . ./.env; set +a
: "${NOTE_ENCRYPTION_KEY:?the §2 key is still required in .env until this section is finished}"
```

That is §1's convention, applied here where it matters most: `--env-file .env` populates Compose's interpolation
and the containers' environment, never the shell you are typing in. Skip it and `$NOTE_ENCRYPTION_KEY` is empty
when the writer runs, which fails safe — `the value on stdin is not base64 of 32 bytes; nothing was written` —
but reads like a broken key generator.

Then the edit itself: Compose interpolation cannot express "either this variable or that one", so this variant is
an explicit edit to `docker/compose.yml` — four pieces, all required:

1. in the `app` service, mount the volume: `volumes: [notes-keys:/run/secrets]` — block style
   (`- notes-keys:/run/secrets`) is fine too; what is not valid is `- ` *inside* `[ … ]`;
2. in `app.environment:`, add `NOTE_ENCRYPTION_KEY_FILE: /run/secrets/note_key`;
3. **delete** the `NOTE_ENCRYPTION_KEY: ${NOTE_ENCRYPTION_KEY:?…}` line (otherwise `config` still demands a
   variable you have decided not to use), and keep `NOTE_ENCRYPTION_KEY` **out** of `.env`;
4. declare the volume at the bottom of the file as `notes-keys: { name: note-taker_notes-keys, external: true }`.
   **External, not internal:** a declared internal volume belongs to the stack, and `docker compose down -v`
   deletes stack volumes — a reflex command whose outcome here is that every note body in `pgdata` becomes
   unrecoverable (§5). External means you created it once and Compose only refers to it.

Then create the volume and put the key in it, without the key ever touching the host filesystem:

```bash
docker volume create note-taker_notes-keys

# The uid:gid the app process runs as, read out of the app image rather than guessed — our Dockerfile sets
# `USER node` by *name*, and recent node:22-slim tags resolve that to 65532 where older ones said 1000. If
# the image does not exist yet, `docker compose --env-file .env -f docker/compose.yml build` first; §2
# builds it as part of `up -d`.
read -r app_uid app_gid <<< "$(docker run --rm --entrypoint sh note-taker-app:latest -c 'echo "$(id -u) $(id -g)"')"

printf '%s\n' "$NOTE_ENCRYPTION_KEY" | docker run --rm -i \
  -v note-taker_notes-keys:/secrets -e APP_UID="$app_uid" -e APP_GID="$app_gid" \
  node:22-slim node -e '
const fs = require("fs");
const uid = Number(process.env.APP_UID);
const gid = Number(process.env.APP_GID);
if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
  console.error("APP_UID/APP_GID must be the numeric uid and gid the app runs as; nothing was written");
  process.exit(1);
}
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c)).on("end", () => {
  const key = Buffer.concat(chunks).toString("utf8").trim();
  if (Buffer.from(key, "base64").length !== 32) {
    console.error("the value on stdin is not base64 of 32 bytes; nothing was written");
    process.exit(1);
  }
  fs.writeFileSync("/secrets/note_key", key + "\n", { mode: 0o600 });
  // The app opens this file as its own user, and this container is root: without the chown the file is
  // root-owned 0600 and the app can never read it.
  fs.chownSync("/secrets/note_key", uid, gid);
  console.log("wrote /secrets/note_key — mode 0600, owned by " + uid + ":" + gid);
});'

docker compose --env-file .env -f docker/compose.yml up -d
# The acceptance check for this section, and it prints nothing: opening the file is the whole question.
docker compose --env-file .env -f docker/compose.yml exec app \
  sh -c 'head -c 0 "$NOTE_ENCRYPTION_KEY_FILE" && echo "the app can open its key file"'
```

Four details in that block are load-bearing.

* **The volume name is the full `note-taker_notes-keys`**, because the step-4 edit declares the volume with
  that explicit `name:` so the one-off writer above and the `app` service's mount are the same volume by
  construction rather than by both sides guessing Compose's project-prefix rules. The shipped file declares
  only `pgdata`: this volume exists only if you made that edit and ran the command above.
* **The key arrives on stdin.** `-e KEY=…` and an inline `node -e '<base64>'` both put the key in `argv`,
  which `ps`, a shell history and `/proc` all read. The uid and gid travel as environment variables because
  they are not secrets, and a numeric uid needs no `/etc/passwd` entry to be chowned to.
* **The writer runs as root and then hands the file over.** `node:22-slim` sets no `USER`, so that container
  is root, while `USER node` is a fact about *our* image — and it is that uid which must own the file. So the
  writer chowns to the pair read out of the app image, and what lands is `65532:65532 0600` (or
  `1000:1000` on an older base): readable by exactly the process that needs it.
* **`--user node` on the writer is not the same fix.** A fresh named volume's root directory is root-owned
  `0755`, so a non-root writer cannot create the file in it, and the `node` user of a base image is not
  guaranteed to be the `node` user baked into the app image. Ownership wrong in the other direction —
  root-owned `0600` — is the loud failure: the app answers
  `NOTE_ENCRYPTION_KEY_FILE (/run/secrets/note_key) could not be read: EACCES`, the boot guard exits non-zero
  before the port is bound, and the container restarts forever without ever reporting `healthy` (§9).

The write is `mode: 0600` for the reason it is written at all: a key file another user of the host can read
is a key file that user has — `0644` would be the sloppy way to make the same file world-readable.

To move an *existing* installation onto a mounted key, step 0 is the whole preparation: `$NOTE_ENCRYPTION_KEY`
has to be the key the database was already written with, and on a running install that is the line still in
`.env` — so source it before piece 3 deletes it. The writer refuses anything that is not base64 of 32 bytes, so
a mistyped paste writes nothing; what it cannot tell is a *valid but different* key, which is why a key change is
§7 and this section is only about where the same key is stored.

A trailing newline is fine — that is what `echo` writes, and `readNoteEncryptionKey()` tolerates it. Changing
which key the rows are sealed with is §7; this section only changes **where the same key is stored**, and a
*mistaken* key change is unrecoverable, so do it as its own change with a backup either side.

`pnpm check:env` warns when a file sets `NOTE_ENCRYPTION_KEY_FILE` — that warning is this section: it is the
`compose.yml` edit you still have to make, and it cannot be checked from the file alone.

---

## 4. Configuration reference

The repo-root `.env` is the whole operator interface. `pnpm check:env` enforces this table against the file
itself (`DOTENV_PATH` to point it at another file), and `apps/server/src/env.ts` enforces the production
rules again inside the container at every boot. A value the linter would print is never key material: it
reports shape and length, not content.

| Variable | Default | Production | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | **none — required**: `development`/`test`/`production` | ✔ `production` | selects the invariant set enforced by the compiled `env.ts`; unset fails everywhere. **Nobody hand-sets it in production:** the image bakes `ENV NODE_ENV=production` into stage 2 and `compose.yml` repeats it in the `app` service `environment:` block. Locally and in CI it comes from the **script line**, never from the shell or from reading the file — so a `NODE_ENV` line in a production `.env` is at best inert and at worst a sourced shell that boots the app with the production invariants off, which is a failure `check:env` reports. |
| `HOST` | `0.0.0.0` | — | bind address |
| `PORT` | `3000` | — | port the **container** listens on; `compose.yml` pins it to 3000 so `EXPOSE`/`HEALTHCHECK` stay valid |
| `HOST_PORT` | `3000` | — | host side of the single published mapping — the operator-facing port knob |
| `POSTGRES_USER` | `notetaker` | ✔ **in `.env` whenever compose is used** | role created by the `db` service; the runbook's shell commands read it, so it must be written into `.env` (Compose's `${VAR:-notetaker}` covers Compose interpolation only) |
| `POSTGRES_PASSWORD` | `notetaker` | ✔ for the compose stack | the only secret the `db` container needs. **Must be URL-safe** — generate with `openssl rand -hex 32`: both DSN compositions embed it **raw** and nothing percent-encodes, so `@ : / + % ? #` silently corrupt the URL. `pnpm check:env` is the only thing that checks it (§2 step 2) |
| `POSTGRES_DB` | `notetaker` | ✔ **in `.env` whenever compose is used** | db created on first init; interpolated into the app's DSN; also the base for the restore drill's `<db>_restore` |
| `POSTGRES_PORT` | `5432` | — | **dev-only** — appears solely in `docker/compose.dev.yml`; the prod `db` publishes nothing (`check:env` warns about it in a production file) |
| `DATABASE_URL` | **unset ⇒ derived** (`postgres://<user>:<pw>@localhost:<port>/<db>` on the host); **set ⇒ verbatim** | ✔ **required in `production`** (in the process) | do **not** set it in the compose stack: `compose.yml` derives it in the `app` service `environment:` block (which beats `env_file:`) with host `db`. `.env.example` ships **no** `DATABASE_URL` line. The one place a runbook sets it explicitly is the restore drill (`run -e DATABASE_URL=…`) |
| `DB_POOL_MAX` | `10` | — | postgres.js pool size |
| `SESSION_TTL_DAYS` | `30` | — | session cookie + DB expiry (> 365 refused in prod) |
| `SECURE_COOKIES` | `false` | ✔ `true` behind TLS | `Secure` flag; refused `false` when `TRUST_PROXY=true` or registration is open |
| `TRUST_PROXY` | `false` | ✔ if behind a proxy | accurate client IPs for rate limiting; PR-07 also reads `X-Forwarded-Host`/`X-Forwarded-Proto` as the CSRF origin, so the proxy in front of `app` has to pass `Host` through or send both |
| `ALLOW_REGISTRATION` | `false` | — | opens `POST /api/auth/register` |
| `NOTE_ENCRYPTION_KEY` | — | ✔ (32 bytes base64) | current AES-256 key |
| `NOTE_ENCRYPTION_KEY_FILE` | — | alternative to the key var | key read from a mounted file by `crypto/keys.ts` at boot (§3) |
| `NOTE_ENCRYPTION_KEY_PREVIOUS` | — | only during rotation | JSON map `{"1": "<base64>"}` of **older** keys; written **single-quoted** in `.env`: Compose strips one quote layer for the container, while the runbook sources the same file in a shell where unquoted JSON is a syntax error |
| `NOTE_ENCRYPTION_KEY_VERSION` | `1` | ✔ set alongside the key | the integer tag stamped into `notes.key_version` for the **current** key; explicit, never derived; bumped by hand, rewritten by `rotate-note-key.js` |
| `LOGIN_RATE_LIMIT_MAX` | `10` | — | failures per 15 min per user+IP |
| `MAX_NOTE_BYTES` | `1048576` | — | body / note size cap |
| `LOG_LEVEL` | `info` | — | pino level |
| `DOTENV_PATH` | `<repo root>/.env` | — | override for the file `loadDevEnvFile()` reads (dev/test) **and** for `scripts/check-env.ts`, which runs in production mode and reads it as data; tests point it at a fixture |
| `APP_NAME` | `Note Taker` | — | SPA title |

Three shapes are worth calling out because both readers have to agree about them:

* **An empty value is an empty value, not the default.** `KEY=` fails the preflight: Compose would hand the
  container an empty string, which for `NOTE_ENCRYPTION_KEY` or `POSTGRES_PASSWORD` is a broken deployment
  that starts.
* **A value is unwrapped exactly once.** `KEY="value"` is fine for both readers (Compose strips the quotes,
  a sourcing shell strips them too). `KEY=has # hash` is not: Compose treats `#` as a comment and `.` does
  not. `export KEY=value` is shell syntax Compose does not understand — and the runbook sources the file
  anyway, which exports every line by itself.
* **JSON has to be single-quoted.** See §7.

---

## 5. Backups

```bash
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"

docker compose --env-file .env -f docker/compose.yml exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "backup-$(date +%F).sql.gz"
```

**`-T` is mandatory.** `docker compose exec` allocates a TTY by default, which CRLF-translates the dump and
corrupts it. Any command in this file whose stdout is piped or redirected gets `-T` for the same reason.

**Plus the key.** Every note body in that dump is AES-256-GCM ciphertext
(`docs/DATA-MODEL.md`, ADR-0002). A database backup without the key is an archive of noise. So the backup
set is the dump **and** one of:

* the repo-root `.env` (which holds `NOTE_ENCRYPTION_KEY`, and — during a rotation only — the
  `NOTE_ENCRYPTION_KEY_PREVIOUS` entries still keeping old rows readable);
* the mounted key file from §3;
* `.dev/note-key` in development, where `crypto/keys.ts` persists the generated key.

Store them together and offline: the dump is useless without the key, and the key is worthless without the
dump, so either one alone is not a backup. Verify the archive before you trust it:

```bash
gzip -t "backup-$(date +%F).sql.gz" && gunzip -c "backup-$(date +%F).sql.gz" | head -3
```

The first lines should read like SQL: a `--` comment header, then `SET` statements. Carriage returns
between the lines mean the `-T` was missing — and §6 step 2 is the place that failure finally shows up.

---

## 6. The restore drill

A backup you have not restored is a rumour. Run this against a **real** backup, in this order, before you
need it. Every step is safe on a live host: nothing here touches the running `$POSTGRES_DB`.

```bash
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"
backup="backup-$(date +%F).sql.gz"     # the artifact §5 produced, gzipped, exactly as it is
```

**1. Create the scratch database — before anything is piped anywhere.** Never over the live
`$POSTGRES_DB`, and do not try the "rename `POSTGRES_DB`" route: the postgres image reads `POSTGRES_DB`
only while initializing an **empty** data directory, so a rename in `.env` changes nothing about an existing
volume.

```bash
docker compose --env-file .env -f docker/compose.yml exec -T db createdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"
```

**2. Restore the dump into it.** `gunzip -c` on the host, `psql` on the container, and `ON_ERROR_STOP=1` so
a half-restored database is an error rather than a success with missing tables:

```bash
gunzip -c "$backup" | docker compose --env-file .env -f docker/compose.yml exec -T db psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" -v ON_ERROR_STOP=1
```

This is the step that catches a bad artifact, and it is the point of the drill: an ungzipped dump, a
TTY-corrupted one, or one from a `pg_dump` that ran while the disk was full all fail here rather than in
front of your notes.

**3. Run a second, throwaway app against the scratch database.** `compose run` **publishes none of the
service's `ports:`** by default, so the port has to be mapped explicitly with `-p`, and it must run
**detached** (`-d`) because step 4 needs it alive while you browse it:

```bash
docker compose --env-file .env -f docker/compose.yml run -d --rm --name restore-drill -p 127.0.0.1:3100:3000 -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/${POSTGRES_DB}_restore" app
```

`-e DATABASE_URL` is the one place in this runbook a DSN is written out longhand, and it is also the reason
`env.ts` never derives one in production: it points the app at `<db>_restore` instead of at the stack's own
database. **The same `NOTE_ENCRYPTION_KEY` must be in force** — it is, because `env_file: ../.env` still
applies to `run` — or every note decrypts to garbage, which is §5's lesson taught the hard way. Confirm the
override landed, with the **plain** `docker` CLI: `docker compose exec`/`stop` take a *service* name, so
`docker compose exec restore-drill …` fails, and `docker compose stop app` would take the **live** app down
mid-drill.

```bash
docker exec restore-drill printenv DATABASE_URL      # …@db:5432/<db>_restore, or stop and re-read step 3
```

**4. Read a note back, then take the drill apart.**

Open `http://127.0.0.1:3100`, log in with your real credentials (they came with the dump), and open a note.
Plaintext on screen means the dump, the key and the app all agree — that is the whole assertion, and it is
the only one that involves a human eye.

```bash
docker stop restore-drill        # plain docker again; `--rm` removes the container
docker compose --env-file .env -f docker/compose.yml exec -T db dropdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"
```

Log the date. A drill you have not run in six months is a drill you have not run.

---

## 7. Key rotation

Six steps, and the app stays up through all of them.

**1. Back up first** — §5, dump *and* key. A rotation is the one procedure in this file whose mistakes are
measured in notes-permanently-unreadable.

**2. Edit the repo-root `.env` by hand**, in one edit: append the outgoing key to the previous map, set the
new current key, bump the version.

```bash
set -a; . ./.env; set +a
echo "current version: ${NOTE_ENCRYPTION_KEY_VERSION}"   # the number that becomes <old>+1
docker run --rm node:22-slim node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

The old base64 is copied out of `.env` **in your editor**, from the file you are editing: it is the one value
in this procedure that must not travel through a terminal, a shell history or a ticket, and the three lines
below are written by moving text inside one file rather than by pasting a secret into a command line.

Then write the three lines:

```
NOTE_ENCRYPTION_KEY_PREVIOUS='{"1": "<the old base64>"}'
NOTE_ENCRYPTION_KEY=<the new base64>
NOTE_ENCRYPTION_KEY_VERSION=2
```

* The `_PREVIOUS` line is **single-quoted**, and the JSON must contain **no single quotes of its own**.
  Compose strips exactly one quote layer for the container, and `set -a; . ./.env` must stay valid shell — a
  bare `{"1": "…"}` is a syntax error to `.` and would stop the runbook sourcing your configuration at all.
* The map holds only **older** keys, keyed by the version they were current for. The current key is never in
  it. `{"1": …}` plus `NOTE_ENCRYPTION_KEY_VERSION=2` is the shape; `check:env` rejects a map containing its
  own current version, with or without the version line present.
* The version is **bumped by hand** to `<old>+1`. It is never derived from the map: deriving it as
  `max(previous)+1` collapses back to `1` the moment the map is emptied and silently orphans every row
  tagged 2.

**3. Restart so the app picks up the new keyring** (the keyring is built at boot):

```bash
docker compose --env-file .env -f docker/compose.yml up -d
docker compose --env-file .env -f docker/compose.yml logs --since 2m app | grep -o 'keyring ready.*'
```

`crypto/keys.ts` logs `note encryption keyring ready` with `keyVersion`, `keyFingerprint` and
`previousVersions` — the fingerprint being the first 8 hex of the key's sha256, and never key material. That
line is how you confirm the container is holding the key you think it is, and it is the line to compare
against after a restore, a rotation, or a redeploy you are not sure took.

**4. Rotate, dry-run first.** The script ships in the image (it is compiled into
`apps/server/dist/scripts/` by `pnpm build`); no `tsx`, no `pnpm`, no toolchain in the container:

```bash
docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js --dry-run
docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js
```

The app is live and autosaving throughout. Each batch takes `SELECT … FOR UPDATE` on the rows it is about to
rewrite and then writes **conditionally** (`WHERE id AND version AND key_version`), re-reading rather than
re-using a buffered ciphertext when that write matched nothing — so a save that lands mid-rotation is never
overwritten. It never bumps `notes.version`: rotating a key is not a content edit, and bumping it would
trip every open tab into a `409` for no reason. It is idempotent, so an interrupted run is resumed by
re-running it.

**5. Verify.**

```bash
docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js --verify; echo "exit=$?"
```

Exit `0` from `--verify` means every row is on the current version **and decrypts**. Exit `1` means rows are
still behind, failed to decrypt, or are *ahead* of this configuration.

**6. Only then may the old entry leave `_PREVIOUS`** — delete the map entry in the next editing session,
not the same one. Until step 5 is clean, rows still reference that key, and removing the entry makes exactly
those rows unreadable.

Then open a note written **before** the rotation in the browser. That is the acceptance check the script's
own `--verify` cannot make: it proves the app, the keyring and the database agree about a body that predates
the new key.

---

## 8. Updates, restarts, TLS, and password recovery

**Upgrade.**

```bash
git pull && docker compose --env-file .env -f docker/compose.yml build && docker compose --env-file .env -f docker/compose.yml up -d
```

The Node bootstrap runs migrations before `listen()`, so there is no separate migration step and no window
in which the app is listening on a schema it does not understand. The rule that buys you an upgrade with no
downtime is: **migrations must be backward-compatible within one minor release** — add columns, do not
rename or drop them, and let the *next* release remove what the previous one stopped reading. A migration
that fails is a container that exits non-zero before binding the port (see §9), which is the failure you
want: the old release is still running, or is still `git checkout`-able.

**Restart / stop.**

```bash
docker compose --env-file .env -f docker/compose.yml restart app    # CRUD survives this; see below
docker compose --env-file .env -f docker/compose.yml stop           # the pgdata volume keeps everything
```

Restart-safety is worth checking after the first upgrade, not after the tenth: create a note, `restart app`,
and confirm the note is still there and still readable. Sessions are in the database, so a restart does not
sign anybody out.

**TLS, and the reverse proxy.** This repository does not implement TLS termination (docs/plans/mvp/MVP-18.md
§8): the app listens on plain HTTP on one port and expects to be fronted. Two supported shapes:

*Exposed on the LAN, plain HTTP* — what you get from §2. Read-only for anyone on the path, so it is a
home-LAN or VPN answer. Keep `ALLOW_REGISTRATION=false`; `SECURE_COOKIES=false` is what a plain-HTTP origin
needs, and `env.ts` refuses the opposite combination.

*Behind a TLS proxy* — first, stop publishing the app on every interface: edit `compose.yml`'s one mapping
to `"127.0.0.1:${HOST_PORT:-3000}:3000"` so only the proxy can reach it. Then forward the host and protocol
the browser actually used, because PR-07 measures the CSRF origin against them:

```nginx
server {
  listen 443 ssl http2;
  server_name notes.example.test;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;                    # or send X-Forwarded-Host instead
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

…and in `.env`:

```
TRUST_PROXY=true
SECURE_COOKIES=true
```

`env.ts` refuses `TRUST_PROXY=true` with `SECURE_COOKIES=false` in production: trusting an upstream proxy
means TLS exists, so a plaintext session cookie is a decision rather than an accident. The app deliberately
sends **no HSTS** header — that policy belongs to the proxy, which is the thing that knows whether HTTPS is
the only thing it speaks.

**Password recovery.** There is no email flow: a self-hosted notes server has one user, who is you.

```bash
docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/reset-password.js <username>
```

It prompts without echoing, changes that user's password hash and their sessions, and nothing else —
folders, notes and settings are untouched, and the integration test in
`apps/server/src/scripts/reset-password.int.test.ts` exists to keep it that way. An unknown username writes
nothing and exits non-zero, so a typo at 3 a.m. cannot lock you out harder.

**Never delete a `users` row to "reset" an account.** Every other `user_id` foreign key in the schema is
`ON DELETE CASCADE` (`docs/DATA-MODEL.md`): sessions, folders, notes, settings. That is not a reset, it is
destruction of the notes, followed by a `POST /api/auth/setup` that answers `409` because an owner row
existed a moment ago.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `error while interpolating services.app.environment.NOTE_ENCRYPTION_KEY: required variable … is missing a value` | Working as designed: the stack refuses to start without a key rather than booting with an empty one. §2 step 1–2. Nothing was created — that failure happens before Docker is asked for anything. |
| `env file /…/note-taker/.env not found` | You ran Compose from `docker/`, or without `--env-file .env`. §1. Production targets deliberately do not create `.env` for you: a copied `.env.example` has no key (§2). |
| `no note-encryption key: set NOTE_ENCRYPTION_KEY …` in `app` logs | The key reached the container empty (a `KEY=` line with nothing after the `=` is an empty value, not the default). `pnpm check:env` names that shape; production never generates a key, and never falls back to plaintext. |
| `NOTE_ENCRYPTION_KEY_FILE (/run/secrets/note_key) could not be read: EACCES`, and `app` restarts forever without reaching `healthy` | The key file exists but its owner is not the user the app runs as — the §3 writer ran as root and did not chown, so a `0600` file is readable only by a user that is not this one. Re-run the §3 writer with the `app_uid`/`app_gid` it reads from the app image, and check with `exec app sh -c 'head -c 0 "$NOTE_ENCRYPTION_KEY_FILE"'`, which opens the file and prints nothing. |
| `DATABASE_URL is required in production` | `DATABASE_URL` reached the process unset — the `environment:` block in `compose.yml` composes it from the trio, so check the trio is complete in `.env` (§4), and that you did not set `DATABASE_URL=` (empty) in the file. |
| `POSTGRES_PASSWORD must match [A-Za-z0-9]+` | From `pnpm check:env` — the container never prints this, because by the time a container runs the password is already inside a DSN it did not build. The character that did it is in `docs/DEPLOY.md` §2 step 2. `openssl rand -hex 32`, and note that changing the *role's* password in the database is a separate statement (`ALTER ROLE`) the runbook does not do for you. |
| `app` logs a Postgres connection or authentication failure, while `db` is `healthy` and `pg_isready` passes | The DSN Compose composed is not the DSN anyone means: usually a `POSTGRES_PASSWORD` containing `@ : / + % ? #`, since nothing percent-encodes the interpolation (§2 step 2 — `check:env` is the only check, and skipping it lands here), sometimes the role's password being changed with `ALTER ROLE` without `.env` following it. `pnpm check:env` names the shape; `docker compose … exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"` proves the database side. |
| `app` never becomes `healthy` | The healthcheck probes `http://127.0.0.1:3000/api/healthz` and a `503` counts as failing, so an app that cannot reach `db` is *unhealthy*, not healthy-with-a-problem. `logs app` first, then `ps` to see whether `db` is `healthy`; a fresh volume needs `initdb`, and `depends_on: service_healthy` waits for it. |
| `SESSION_TTL_DAYS must be <= 365 in production` | Production invariant, on purpose. §4. |
| `SECURE_COOKIES must be true when TRUST_PROXY is true` | §8's TLS section. If you are not behind TLS, set `TRUST_PROXY=false`; if you are, set `SECURE_COOKIES=true`. |
| Notes read as garbage after a restore or a redeploy | The app is running with a different key than the one that wrote the rows. The boot line `note encryption keyring ready` carries `keyVersion` and `keyFingerprint` (§7 step 3); compare the fingerprint with the key you believe the database has. If that key is gone, §5's "the key is part of the backup" is the lesson. |
| Login works but every request 403s behind the proxy | The CSRF origin is measured against the authority the client used: the proxy must pass `Host` through or send `X-Forwarded-Host`/`X-Forwarded-Proto` (§8). |
| `docker compose exec restore-drill …` says no such service | Correct: it is a `run` container, not a service. Plain `docker exec restore-drill` / `docker stop restore-drill` (§6 step 3). |
| `GET /` returns a JSON `404` envelope | The SPA is not being served. `plugins/static-spa.ts` (PR-12) is the file that serves the `apps/web/dist` this image stages at that path; until it exists only `/api/**` answers. `/api/healthz` still works, which is what the healthcheck needs. |
| The build fails at `pnpm install --frozen-lockfile` | The lockfile and the manifests disagree. This repository installs with `pnpm` pinned by `packageManager`; fix it with `pnpm install` and commit the lockfile, never with `--no-frozen-lockfile`. |
| The build fails with `… is in the production tree` | A dependency moved from `devDependencies` to `dependencies`, or the pruned install stopped being pruned: the assertion is in the Dockerfile's `prune` stage and it is asserting the runtime layer has no build toolchain. Fix the manifest, not the assertion. |
| `pnpm check:env` fails on a file you copied from `.env.example` | Correct: a production `.env` must not carry `NODE_ENV` (or `DATABASE_URL`, or an empty `KEY=`). §4 says what the linter wants absent, and `make check-env` is the same command. |
