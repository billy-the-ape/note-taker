# Note Taker — local development interface (docs/plans/mvp/MVP-02.md).
#
# A cold clone needs two commands:
#
#     pnpm i && make db-up && make dev
#
# **Why every DB target spells Compose out in full.** Compose resolves its project directory from the
# compose file's location, so `docker compose -f docker/compose.dev.yml …` on its own auto-loads `.env`
# from `docker/` instead of the repo root where the file lives — and a `--env-file` path that does not
# exist is a hard error before Docker is even contacted. So the repo root plus **both** flags is the only
# correct invocation; it is pinned once in `$(COMPOSE)` below, and PR-18 copies the rule for
# `docker/compose.yml`. This Makefile is the interface: nobody should have to remember the flags, and
# every target is written to be run from the repo root.
#
# There is no `db:seed`/migrate target here on purpose: the schema and the migration runner arrive in
# PR-04 and the demo seed in PR-09, so a target that ran them now would only be a stub.

.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

COMPOSE := docker compose --env-file .env -f docker/compose.dev.yml
# PR-18's production stack, spelled identically to the dev line above and for the identical reason: Compose
# resolves its project directory from the compose file's location, so `-f docker/compose.yml` alone would
# load `.env` from `docker/`. docs/DEPLOY.md uses this exact invocation in every command an operator
# copy-pastes, so the Makefile and the runbook cannot drift. These targets deliberately do NOT depend on
# bootstrap-env: a production `.env` is generated (docs/DEPLOY.md §2), and a copied .env.example would carry
# neither a key nor the trio the runbook sources, which is a parse error worth hearing out loud.
COMPOSE_PROD := docker compose --env-file .env -f docker/compose.yml
PNPM := pnpm

.PHONY: help bootstrap-env db-up db-down db-reset dev build test coverage check-env \
        prod-config prod-build prod-up prod-down prod-ps prod-logs

help:
	@echo 'Note Taker — run these from the repo root'
	@echo '  make db-up        start the dev Postgres (Docker) and wait until it is healthy'
	@echo '  make db-down      stop it (the pgdata-dev volume keeps its data)'
	@echo '  make db-reset     destroy the dev volume and start a fresh Postgres'
	@echo '  make dev          run the app on the host: API :3000 + Vite :5173 (needs db-up)'
	@echo '  make build        build every app (tsc -> apps/server/dist, Vite -> apps/web/dist)'
	@echo '  make test         run the unit tests'
	@echo '  make coverage     run the unit tests with v8 coverage (what CI runs)'
	@echo '  make bootstrap-env  create .env from .env.example if it is missing (all db targets do this)'
	@echo '  make check-env      pnpm check:env — lint the repo-root .env against the production rules'
	@echo ''
	@echo 'The production stack (docker/compose.yml, PR-18). Read docs/DEPLOY.md before the first up:'
	@echo '  make prod-config  compose config: interpolate .env, failing by name if the key is missing'
	@echo '  make prod-build   build the image (multi-stage; nothing in this repo is ever pushed)'
	@echo '  make prod-up      db + app on one published port, migrations inside the app'
	@echo '  make prod-down    stop it (the pgdata volume keeps its data)'
	@echo '  make prod-ps      both services, with the app reporting healthy'
	@echo '  make prod-logs    follow the app container'

# Compose hard-errors when --env-file points at a missing file, so `.env` is bootstrapped rather than
# assumed. `test -f` short-circuits, so an existing .env (and every local edit in it) is left alone, and
# no real .env can be committed: .gitignore only ever whitelists .env.example.
bootstrap-env:
	@test -f .env || cp .env.example .env

# --wait blocks until every service reports healthy, which is what makes `make db-up && pg_isready …`
# and a following `make dev` deterministic instead of racing initdb.
db-up: bootstrap-env
	$(COMPOSE) up -d --wait

db-down: bootstrap-env
	$(COMPOSE) down

# -v is what drops the named volume (pgdata-dev); the up below then re-runs initdb from scratch.
db-reset: bootstrap-env
	$(COMPOSE) down -v
	$(COMPOSE) up -d --wait

# The app is never containerized in dev (the prod image is PR-18): Docker hosts the DB only, so the API
# and the editor hot-reload from the host. bootstrap-env is here because loadDevEnvFile() reads this same
# file — pnpm dev also works with no .env at all, it just then uses the env.ts defaults.
dev: bootstrap-env
	$(PNPM) dev

build:
	$(PNPM) build

test:
	$(PNPM) test

# The CI `unit` job runs pnpm coverage, so the thresholds live in the Vitest configs, not in a flag here.
coverage:
	$(PNPM) coverage

# The preflight, behind the same interface as everything else. It judges the *file*, so it is at its most
# useful when the shell has nothing in it; `DOTENV_PATH=/somewhere pnpm check:env` judges another file.
check-env:
	$(PNPM) check:env

# ── production (PR-18) ──────────────────────────────────────────────────────────────────────────────
# Each of these is `$(COMPOSE_PROD)` and nothing more: the flags are the interface, and docs/DEPLOY.md
# spells the same command out in full so an operator who never opens a Makefile types exactly the same thing.

# The parse-time preflight. `config` never contacts the daemon, so this is the one production check that
# works on a host with Docker installed and nothing running yet (docs/DEPLOY.md §2, step 2b).
prod-config:
	$(COMPOSE_PROD) config

prod-build:
	$(COMPOSE_PROD) build

prod-up:
	$(COMPOSE_PROD) up -d

prod-down:
	$(COMPOSE_PROD) down

prod-ps:
	$(COMPOSE_PROD) ps

prod-logs:
	$(COMPOSE_PROD) logs -f app
