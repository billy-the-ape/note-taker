# MVP-02 · PR-02 — Local dev infrastructure (Postgres in Docker, Makefile)

> **Task ID:** `PR-02` · **Branch:** `chore/pr-02-dev-infra` · **Size:** S (≤ ½ day) · **Depends on:** PR-01 (merged)
> **Track:** A Foundation · **Review gate:** M0 · **Unblocks:** PR-04 (needs a dev DB), PR-18 (copies the invocation rule)

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~15k tokens** | this brief (1.9k as written) + PR-01 output you must read (`package.json` scripts, `apps/server/src/env.ts`, `.env.example`, `README.md`) + Docker Compose syntax recall + log output while proving the acceptance steps |
| **Output** | **~3.5k tokens** | 2 new files (`docker/compose.dev.yml`, `Makefile`), an `.env.example` extension, a README "Local development" section |
| **Session total** | **~19k tokens** | ≈ half an engineer-day (`S`); the acceptance drill (cold clone → `make db-up` → `make dev`) dominates wall-clock time, not tokens |

> 1 token ≈ 4 chars; ±30%. Docker image pulls are wall-clock cost, not token cost.

---

## 1. Goal

A cold clone gets a healthy Postgres 16 and the hello-world app with **two commands**: `make db-up` and `make dev`.
No migrations, no seeds, no CI changes here.

## 2. Repo state you can assume (PR-01 merged)

- pnpm monorepo: `apps/server` (Fastify, `NODE_ENV=development tsx watch src/index.ts` on `:3000`),
  `apps/web` (Vite `:5173` proxying `/api` → `:3000`).
- `apps/server/src/env.ts` exports **`loadDevEnvFile()`** (no-op unless process `NODE_ENV` is `development`/`test`;
  reads `process.env.DOTENV_PATH ?? <repo root>/.env`; swallows only `ENOENT`) and **`databaseUrl()`** (set
  `DATABASE_URL` ⇒ verbatim; unset + dev/test ⇒ composed from `POSTGRES_*` with host `localhost`; unset + production ⇒
  hard failure). Both are PR-01 artifacts you must **not** duplicate.
- `.env.example` currently contains only `NODE_ENV=development`.
- No `.gitignore`d `.env` exists on a cold clone; no `Makefile`; no `docker/`.
- **No DB code exists yet** — there is no schema, no drizzle config, no `db:*` scripts. That is deliberate.

## 3. Global PR rules

- Conventional-commit title; PR body starts with `Task: PR-02`.
- CI green; never lower a coverage threshold; no coverage work in this PR at all.
- Docs updated in the same PR (`AGENTS.md` rule): this PR adds `make` targets, so document them in `README.md` and, if
  `AGENTS.md` lists dev commands, mention `make db-up`.
- Never commit a real `.env`; commit only `.env.example`. No committed credentials — dev defaults only.

## 4. The Compose rule this PR establishes (PR-18 follows it exactly)

Compose resolves its **project directory from the compose file's location**, so with `-f docker/compose.dev.yml` it
auto-loads `.env` from `docker/` — **not** from the repo root. Therefore **every `make` target pins the full
invocation**:

```
docker compose --env-file .env -f docker/compose.dev.yml <up|down|…>
```

run from the repo root. Operators must never have to remember this — the Makefile is the only interface.

**`.env` is bootstrapped, never assumed.** Compose hard-errors when the `--env-file` path is missing, so a cold clone
would fail before Docker is even contacted. Add a `bootstrap-env` helper target:

```make
bootstrap-env:
	test -f .env || cp .env.example .env
```

and make every target that passes `--env-file .env` (`db-up`, `db-down`, `db-reset`, `dev`) depend on it.

## 5. Files to create / modify

1. **`docker/compose.dev.yml`** — one service: `postgres:16-alpine`, named volume (`pgdata-dev`), `POSTGRES_USER` /
   `POSTGRES_PASSWORD` / `POSTGRES_DB` interpolated from `.env` with `${VAR:-notetaker}` defaults, published host port
   `${POSTGRES_PORT:-5432}:5432`, healthcheck `pg_isready -U …` with the two variables escaped so the container's own
   shell expands them (written unescaped, Compose would interpolate them out of `.env` at config time instead),
   `restart: unless-stopped`, and a pinned compose project name so the volume/network names are identical in every
   clone or worktree on a machine.
2. **`Makefile`** — targets `bootstrap-env`, `db-up`, `db-down`, `db-reset`, `dev`, `build`, `test`, `coverage`.
   **No `db:seed`/`db-reset`-with-migrations target**: seeding arrives with PR-09 (there is no schema and no auth service
   to hash a demo password with yet).
3. **`.env.example`** — extend PR-01's file with the dev-only values the dev compose interpolates:
   `POSTGRES_USER=notetaker`, `POSTGRES_PASSWORD=notetaker`, `POSTGRES_DB=notetaker`, `POSTGRES_PORT=5432`,
   `HOST_PORT=3000`. **Deliberately add no `DATABASE_URL` line** — leaving it unset is what makes one
   `POSTGRES_PORT`/`POSTGRES_PASSWORD` edit move *both* the dev container and every host process (PR-04's acceptance
   pins that). Keep `NODE_ENV=development` (it is for Compose interpolation and for the human; no Node process reads its
   mode from this file).
4. **`README.md`** — a "Local development" section documenting `make db-up` / `make dev` (and `make db-reset`), plus the
   `cp .env.example .env` note (the `bootstrap-env` target does it for you).

## 6. Required behavior

- `make db-up` on a cold clone: creates `.env` from `.env.example` if missing, then starts a healthy Postgres on
  `localhost:5432` (or `${POSTGRES_PORT}`). The target runs `up -d --wait`, so it returns only once the container's
  healthcheck passes and a following `pg_isready` cannot race initdb.
- `make db-down` stops it; `make db-reset` recreates it (down `-v` for the dev volume, then up).
- `make dev` runs the app on the host (`pnpm dev`: `tsx watch` API `:3000`, Vite `:5173`) — Docker is used for the DB
  only; the app is never containerized in dev (the prod image is PR-18).
- Changing `POSTGRES_PORT` in the **repo-root** `.env` and re-running `make db-up` really changes the published host
  port (proves Compose is reading that file).

## 7. Acceptance criteria

- [ ] From a cold clone (`pnpm i` only — **no `.env`, no schema**): `make db-up` creates `.env` from `.env.example` and
      leaves a healthy Postgres: `pg_isready -h localhost -p 5432` exits 0.
- [ ] `make db-reset` recreates it.
- [ ] `make dev` serves the hello-world app and `GET http://localhost:3000/api/health` returns `{status:'ok'}`.
- [ ] Editing `POSTGRES_PORT` in the repo-root `.env` then `make db-up` moves the published port (prove with
      `docker compose ps` / `pg_isready -p <new>`).
- [ ] Every compose-facing target uses `--env-file .env -f docker/compose.dev.yml` from the repo root.
- [ ] No committed credentials; `.env` remains gitignored; `README.md` "Local development" section present.
- [ ] **Not asserted (cannot pass yet):** `pnpm db:migrate`, `pnpm db:seed`. PR-04 owns the first green `db:migrate`;
      PR-09 owns `scripts/seed-demo.ts` + `pnpm db:seed`. Do not stub them.

## 8. Test plan

Nothing to unit-test (compose + make only). The proof is the shell sequence above: `pg_isready` exit code and
`GET /api/health` = `ok`. Paste both transcripts in the PR body.

## 9. Out of scope

Production image/compose (PR-18), CI (PR-03), migrations and any `db:*` script (PR-04), seed data (PR-09), Postgres
extensions beyond what the image provides (PR-04 adds `pgcrypto` via migration), `.dockerignore`/`Dockerfile`.

## 10. PR body template

```
Task: PR-02

## What
docker/compose.dev.yml (postgres:16-alpine + pgdata volume + healthcheck), Makefile (bootstrap-env, db-up, db-down,
db-reset, dev, build, test, coverage), .env.example extended with POSTGRES_*/HOST_PORT and no DATABASE_URL,
README "Local development".

## Acceptance evidence
- cold clone: `make db-up` → `.env` created → `pg_isready -h localhost -p 5432` → 0
- `make dev` → `curl :3000/api/health`
- POSTGRES_PORT edit changes the published port after `make db-up`
```
