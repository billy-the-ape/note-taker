# Note Taker

note-taker is currently in the INITIAL MVP PLANNING PHASE (user generated). 

The full MVP plan (architecture, repository map, and the PR-by-PR task breakdown) lives in
[docs/plans/mvp/MVP-FULL-PLAN.md](docs/plans/mvp/MVP-FULL-PLAN.md). Each PR is also a standalone work order in the same
folder ([`MVP-01.md`](docs/plans/mvp/MVP-01.md) … [`MVP-20.md`](docs/plans/mvp/MVP-20.md), indexed by
[`docs/plans/mvp/README.md`](docs/plans/mvp/README.md)) — an agent implementing one PR needs only that file.

## Local development

Prerequisites: Node 22 (`.nvmrc`), pnpm (pinned by `packageManager`), GNU Make, and Docker with the
Compose v2 plugin. Then a cold clone needs two commands — Docker hosts **only** the database, the app
always runs on the host so the API and the editor hot-reload:

```bash
pnpm i
make db-up                                    # Postgres 16 in Docker, healthy on localhost:5432
make dev                                      # API on :3000 (tsx watch) + Vite on :5173 (proxies /api → :3000)
curl -s http://localhost:3000/api/health      # {"status":"ok","db":"ok","version":"0.1.0"}
pg_isready -h localhost -p 5432               # accepts connections to the dev database
```

`make db-up` publishes Postgres on `127.0.0.1` only, so the `notetaker`/`notetaker` dev defaults are never
reachable from the LAN; host tools dial `localhost`, which falls back to IPv4 when it resolves to `::1`.

| Target                                   | What it does                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `make db-up`                             | start the dev Postgres and block until its healthcheck passes                   |
| `make db-down`                           | stop it; the `pgdata-dev` volume keeps its data                                 |
| `make db-reset`                          | `down -v` (destroys `pgdata-dev`) and start a fresh one                         |
| `make dev`                               | run both apps on the host (`pnpm dev`)                                          |
| `make build` / `test` / `coverage`       | the `pnpm` equivalents, so the repo root has a single interface                 |
| `make bootstrap-env`                     | `test -f .env \|\| cp .env.example .env` — every `db-*`/`dev` target runs it first |

**`.env` is created for you and is never required.** `make bootstrap-env` copies `.env.example` when no
`.env` exists (an existing file is left alone), and `pnpm dev` also boots from a bare clone with none at
all. That copy is where the optional dev overrides go — `POSTGRES_PORT` to publish the container
somewhere else, `HOST_PORT` for the production stack (PR-18). The file deliberately carries **no
`DATABASE_URL`**: `apps/server/src/env.ts` composes the DSN from the same `POSTGRES_*` values, so one
`POSTGRES_PORT` edit moves the container and every host tool together. Never commit a real `.env`.

**Why the Makefile spells Docker out.** Compose resolves its project directory from the compose file's
location, so `docker compose -f docker/compose.dev.yml …` alone would load `.env` from `docker/` instead
of the repo root (and a missing `--env-file` path is a hard error). Every target therefore pins the full
invocation, always run from the repo root — the same rule PR-18 follows for `docker/compose.yml`:

```bash
docker compose --env-file .env -f docker/compose.dev.yml <up|down|ps|logs>
```

The database is real from PR-04 on: `make db-up`, then `pnpm db:migrate` applies the committed migrations in
`apps/server/migrations/`, and `pnpm dev` (or `node apps/server/dist/index.js`) runs the same migration runner
at boot before it starts listening, so a fresh volume is servable without a second command. `pnpm test:integration`
is the only test suite that needs a database; `pnpm test` never touches one. `pnpm db:seed` (demo data) arrives
with PR-09, and there is no `make` target pretending otherwise. `docs/DATA-MODEL.md` documents the schema, the
indexes and the invariants the server relies on.

## It will become:

### A simple, lightweight web app, which can be easily self hosted and assigned to a port
  - Docker 

### Built in a sensible, modern framework, using the proper standard structures and packages.
  - I personally like nodejs/react/tailwind/tanstack/zod/psql+drizzle, but open to other options if they are more ideal.

### Have full CI suite
  - lint+typings+unit tests with coverage bare minimum.

### Have very basic authentication, username+password.
  - I'm interested in including passkey as alternative to password authentication *not needed for mvp if more complex than a few lines of code
  
### Manage markdown notes, saving them in a folder structure.
  - Backend stores saved notes efficiently & securely. 2 way encrypted?
  - Folders and notes persistence: Raw file system? or database?
  - Folders and filenames can be renamed.
  - Auto-save can be enabled (default on).
  - File names are auto generated as new-file-<msepoch>.md - ask for file name when creating new document with this pre-populated (and extension not editable)

### Provide a text editor UI producing markdown. 
  - Text can be edited "word" style (edit formatted markdown directly with toolbar) 
  OR
  - Text can be edited with raw markdown and format previewed.
