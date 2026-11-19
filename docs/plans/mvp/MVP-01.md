# MVP-01 · PR-01 — Monorepo scaffold, tooling, runnable hello-world app

> **Task ID:** `PR-01` · **Branch:** `feat/pr-01-scaffold` · **Size:** M (1–2 days) · **Depends on:** — (first PR)
> **Track:** A Foundation · **Review gate:** M0 · **Unblocks:** PR-02, PR-03, PR-04, PR-05 (everything)

This file is a **self-contained work order**. Everything you need is here; you do not need to load
`MVP-FULL-PLAN.md` into your context. It restates the plan's stack, config, CI and rules that bear on this PR.

## Token estimate (size the coding session from this)

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~22k tokens** | this brief (4.3k as written) + existing repo files to read (`README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/CI.yml`, `.github/workflows/claude-review.yml`) + toolchain references you will consult (pnpm workspaces, Fastify 5, Vite 7 + React 19, Biome, Vitest, TypeScript 5 `strict`) + re-reading your own output during verification |
| **Output** | **~11k tokens** | ~30 new files: 11 root config/manifest files, 8 server files, 9 web files, 2 test files, plus a 10-line `AGENTS.md` edit |
| **Session total** | **~33k tokens** | ≈ one `M`-sized engineer-day; budget ~45k with two verification loops |

> Basis: 1 token ≈ 4 chars of source; ±30%. No DB, no Docker, no UI beyond a placeholder card — the file count is what
> drives the cost. If you add each dependency with `pnpm add` instead of hand-writing manifests, add ~3k output tokens.

---

## 1. Goal

A cloneable repo where `pnpm i && pnpm dev` serves a page and `pnpm build` produces a deployable artifact, **with every
quality gate in place from day one** so later PRs only *add* tests and never bolt on tooling. There is **no database
code and no real UI** in this PR.

The one non-obvious requirement running through the whole PR: the app must boot **from a bare clone with no `.env`
file**, which forces `NODE_ENV` to be supplied by the script line and forces one exported env-loading + DSN-resolving
pair in `env.ts` that every later PR reuses.

## 2. Repo state you can assume (at the time you start)

```
README.md                     # planning-phase text, links to docs/plans/mvp/MVP-FULL-PLAN.md
AGENTS.md                     # one-line pointer to README + "keep docs correct in the same PR"; lists NO commands
CLAUDE.md                     # "@AGENTS.md"
.clinerules/{editing.md,terminal.md,hooks/PreToolUse}
.github/workflows/CI.yml      # placeholder job only, `name: CI`
.github/workflows/claude-review.yml   # triggers on workflow_run: workflows: ["CI"]
docs/plans/mvp/               # the plan + task briefs
```

No `package.json`, no `apps/`, no `packages/`, no `pnpm-lock.yaml`, no `.gitignore`. Node 22 and pnpm are available
locally; Docker is available (but this PR does not need it).

## 3. Global PR rules (apply to every MVP PR — repeated here so you never need the parent plan)

- Conventional-commit titles (`feat:`, `chore:`, `test:`, `docs:`). PR body **starts with** `Task: PR-01`.
- CI must be green. Never lower a coverage threshold (thresholds only ratchet upward; lowering one needs written
  justification in the PR description).
- A PR that changes behavior updates the docs it invalidates **in the same PR** (`README.md`, `AGENTS.md`,
  `docs/*`) — required by `AGENTS.md`.
- Any decision change to the plan's §4 table needs a new ADR under `docs/adr/` **and** an update to
  `docs/plans/mvp/MVP-FULL-PLAN.md` (and the affected `MVP-NN.md` brief) in the same PR.
- Every new DB column ships with a generated migration in the same PR (not applicable to this PR — no DB yet).
- Never commit a real `.env`; `.gitignore` covers `.env*` except `.env.example`. No secrets, ever.

## 4. Stack (decided; do not re-litigate)

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22 LTS (pinned by `.nvmrc`), TypeScript 5 `strict`, **ESM everywhere** |
| Packages | pnpm workspaces; version pinned via `packageManager` in the root `package.json` |
| Server | Fastify 5 + `fastify-type-provider-zod` (+ `@fastify/static` later, in PR-12) |
| DB | Postgres 16 + `drizzle-orm` + `postgres` (postgres.js) + `drizzle-kit` — **not in this PR** |
| Validation | Zod v4 in `packages/contracts` (shared) — **package lands in PR-05, not here** |
| Client | React 19 + Vite 7 + TanStack Router (file-based) + TanStack Query |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` |
| Testing | Vitest + `@vitest/coverage-v8` (Playwright arrives in PR-19) |
| Quality | Biome (lint + format + import sorting) + `tsc --noEmit` |
| Infra | `tsx watch` for dev (Docker arrives in PR-02/PR-18) |

Workspace names: `apps/server`, `apps/web`, and later `packages/contracts` published internally as
`@note-taker/contracts`.

## 5. Files to create

**Root:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.editorconfig`, `.gitignore`,
`.dockerignore`, `.nvmrc`, `LICENSE` (MIT), `.env.example`, `pnpm-lock.yaml` (committed — CI uses
`--frozen-lockfile`).

**`apps/server/`:** `package.json`, `tsconfig.json`, `vitest.config.ts`,
`src/{index.ts,app.ts,env.ts,logger.ts,routes/health.routes.ts}`, `src/env.test.ts`, `src/app.test.ts`.

**`apps/web/`:** `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`,
`src/main.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx` (a "coming soon" card), `src/styles/globals.css`.

**Modify:** `AGENTS.md` — it lists no commands today, so **this PR adds its first-ever command list**
(`pnpm i / dev / build / lint / format / typecheck / test`), because the same-PR doc rule forbids leaving it stale while
PR-20 waits at the end. PR-20 only *consolidates* later edits.

## 6. Required behavior

### 6.1 Root scripts (exact contract later PRs depend on)

`dev`, `build`, `build:packages`, `lint`, `format`, `typecheck`, `test`, `test:integration`, `coverage` are declared at
the root.

- `build:packages` = `pnpm -r --filter './packages/**' build`. Declared **here**, even though `packages/` first appears
  in PR-05: PR-03's CI calls it from day one, and while nothing matches the filter it is a no-op.
- `dev` = `pnpm build:packages && pnpm -r --parallel --filter './apps/**' dev` (pnpm's own parallel runner — no extra
  dependency). The leading build is a no-op until PR-05, after which it is what lets `tsx`/`vite` resolve
  `@note-taker/contracts` at all.
- `test:integration` and `coverage` are **declared but the integration config arrives in PR-04**; do not create
  `vitest.integration.config.ts` here.
- **No `db:*` scripts and no `test:e2e` here.** `db:generate`/`db:migrate` arrive with PR-04, `db:seed` with PR-09,
  `check:env` with PR-18, `test:e2e` with PR-19. `pnpm db:migrate` must fail as "unknown script" until PR-04.
- **Every host script that reads env declares `NODE_ENV` inline on its own command line.** `apps/server`'s `dev` is
  `NODE_ENV=development tsx watch src/index.ts` (POSIX form; the `cross-env` variant is a plan §21 open question, do not add
  the dependency now). The rule is a **contract the later PRs implement**: `db:generate`/`db:migrate` are
  `NODE_ENV=development drizzle-kit …` (PR-04), `db:seed` is `NODE_ENV=development tsx scripts/seed-demo.ts` (PR-09),
  `test:integration`/`coverage:integration` are `NODE_ENV=test vitest run --config …` (PR-04), `check:env` is
  `NODE_ENV=production tsx scripts/check-env.ts` (PR-18). Rationale: `loadDevEnvFile()` and `databaseUrl()` gate on the
  **process** `NODE_ENV`, and a `.env` line can never supply it. A script that forgets the assignment must die on the
  missing-`NODE_ENV` error rather than silently pick a mode — so **do not paper over it with a default anywhere**.

### 6.2 `tsconfig.base.json`

`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
`verbatimModuleSyntax: true`, ESM module settings. Server is built with plain `tsc` (no bundler) to
`apps/server/dist`; web builds to `apps/web/dist`.

### 6.3 `apps/server/src/env.ts` — the load-bearing file

Zod-parsed `process.env`, failing fast with a readable list of problems. Rules:

- **`NODE_ENV` is required with no default.** Unset, or any value other than `development | test | production`, fails in
  **every** environment, with a message naming the variable. A container that forgot it must not boot in the
  least-restrictive mode.
- Other vars this PR parses (defaults shown): `HOST=0.0.0.0`, `PORT=3000`, `LOG_LEVEL=info`,
  `DB_POOL_MAX=10`, `SESSION_TTL_DAYS=30`, `SECURE_COOKIES=false`, `TRUST_PROXY=false`,
  `ALLOW_REGISTRATION=false`, `LOGIN_RATE_LIMIT_MAX=10`, `MAX_NOTE_BYTES=1048576`, `APP_NAME=Note Taker`.
  Production-only invariants to encode now (the rest arrive with the features that need them):
  `SESSION_TTL_DAYS > 365` → refuse; `SECURE_COOKIES=false` while `TRUST_PROXY=true` → refuse;
  `ALLOW_REGISTRATION=true` while `SECURE_COOKIES=false` → refuse.
- **`loadDevEnvFile()` (exported).** Called at the top of every host-run entry point that boots something
  (`index.ts` now; the Vitest setup file of `vitest.integration.config.ts` and `drizzle.config.ts` in PR-04;
  `scripts/seed-demo.ts` in PR-09). Behavior:
  - no-op unless the **process** `NODE_ENV` is `development` or `test`;
  - path = `process.env.DOTENV_PATH ?? <repo root>/.env`, where the repo root is the first directory at or above
    `import.meta.dirname` containing `pnpm-workspace.yaml` (**a fixed `../../.env` is wrong** — under `tsx` from
    `apps/server/src/` it lands on `apps/.env`, and the depth changes again once compiled to `dist/`);
  - `process.loadEnvFile(path)` inside a `try` that swallows **only** `ENOENT` (missing file is normal — a bare clone —
    while a *malformed* file must fail loudly). Node 22 built-in ⇒ **no `dotenv` dependency**.
  - Why a function and not a flag: `node --env-file` hard-fails when the file is missing (exit 9), and
    `--env-file-if-exists=../../.env` would need a different relative path per entry point and would still have to be
    added to `db:migrate`, `db:seed` and `test:integration` separately.
- **`databaseUrl()` (exported) — the single DSN resolver.** Nothing else may build a DSN ad hoc.
  1. `DATABASE_URL` set (process env or file) ⇒ use it **verbatim** (`process.loadEnvFile` does no `${VAR}` expansion).
  2. Unset and `NODE_ENV` is `development`/`test` ⇒ derive
     `postgres://${POSTGRES_USER ?? 'notetaker'}:${POSTGRES_PASSWORD ?? 'notetaker'}@localhost:${POSTGRES_PORT ?? 5432}/${POSTGRES_DB ?? 'notetaker'}`
     (host literally `localhost`: this branch only runs outside containers). Because nothing percent-encodes on the way,
     **validate first** that `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` match `[A-Za-z0-9]+`; a value containing
     `@ : / + % ? #` must fail with a readable error **naming the variable** instead of returning a mangled DSN.
  3. Unset and `NODE_ENV=production` ⇒ fail naming `DATABASE_URL` (no derivation, no default).
  In `development`/`test`, if an explicit `DATABASE_URL` disagrees with the `POSTGRES_*` values from the same file
  (different port or db), log **one** warning naming both.
  `index.ts` (and later `db/client.ts`, `db/migrate.ts`) all go through it.
- Precedence: **the environment beats the file** — `process.loadEnvFile` does not overwrite already-set keys.

### 6.4 `apps/server/src/{index.ts,app.ts,logger.ts,routes/health.routes.ts}`

- `index.ts`: `loadDevEnvFile()` → parse env → `buildApp(deps)` → `listen()` → graceful shutdown (SIGTERM/SIGINT).
  Migrations are **not** wired yet (PR-04 owns `db/migrate.ts`); leave the clearly-marked slot in the bootstrap.
- `app.ts`: `buildApp(deps)` factory — dependency injection so tests never bind a port. Register `@fastify/cookie`?
  **No** — that belongs to PR-07. Keep it to logger + health route + error handling placeholder.
- `health.routes.ts`: `GET /api/health` → `{ status:'ok', db:'ok', version }` (in this PR `db` is a static `'ok'`;
  PR-04 makes it real) and `GET /api/healthz` alias for the Docker `HEALTHCHECK` that PR-18 adds.
- `logger.ts`: pino, level from `LOG_LEVEL`.

### 6.5 Vitest configs (split rule — pre-configure it now so PR-04 never edits them)

Both unit configs set `include: ['src/**/*.test.{ts,tsx}']` **and** `exclude: ['**/*.int.test.ts']`, because Vitest's
default include (`**/*.{test,spec}.*`) would otherwise pull the DB-backed files PR-04 adds into `pnpm test` and into the
Postgres-free `unit` job. The **web** config additionally sets `passWithNoTests: true` (PR-01 ships no web tests and
Vitest otherwise exits 1 — which would break this PR's own acceptance and PR-03's `unit` job); the **server** config
does not, because `env.test.ts`/`app.test.ts` exist from day one. The web config carries **no `coverage.thresholds`**:
the `apps/web/src/lib` row is armed by PR-05 and the overall `apps/web/src` row by PR-08.

Coverage thresholds you *do* set now (server): `src/{crypto,domain}` 80/80/75/80 — those directories are empty today,
so set the row only if it cannot fail; if it would, leave the scope unset and let PR-06 arm it. Never set a threshold
over a scope with nothing in it.

### 6.6 `.env.example`

Ships **`NODE_ENV=development` only** in this PR (PR-02 adds `POSTGRES_*`/`HOST_PORT`; PR-06/PR-18 add the key and prod
vars). That line is for Compose interpolation and for the human reading the file — **no Node process takes its mode
from it**. Do **not** add a `DATABASE_URL` line (PR-02 keeps it out on purpose so one `POSTGRES_*` edit moves both the
dev container and the host tools). The README quick start says `cp .env.example .env`, but this PR must boot with **no
`.env` at all**, since the Makefile that copies it only arrives in PR-02.

### 6.7 `apps/web`

Vite 7 + React 19 + Tailwind v4 (`@tailwindcss/vite`) + TanStack Router file-based routes with `__root.tsx` and an
`index.tsx` "coming soon" card. Vite dev server on `5173` **proxies `/api` to `:3000`**. `index.html` title from
`APP_NAME`-style constant or plain "Note Taker".

## 7. Acceptance criteria (every box must be provable)

- [ ] **From a bare clone with no `.env` file**, `pnpm i && pnpm dev` boots and `GET /api/health` returns
      `{status:'ok'}` — the dev path supplies `NODE_ENV=development` on its own.
- [ ] The `NODE_ENV` guard is proven **without** going through `pnpm dev` (whose inline assignment would defeat any
      `env -u NODE_ENV` attempt — deliberately *not* the test):
      (a) `env.test.ts` asserts that parsing an env with `NODE_ENV` absent fails with the readable missing-var message in
      every branch (`development`, `test`, `production`, unset);
      (b) after `pnpm build`, `env -u NODE_ENV node apps/server/dist/index.js` exits **non-zero before `listen()`** —
      the compiled entry, so nothing in the chain re-supplies the value.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0.
- [ ] Vite proxies `/api` to `:3000` (curl `localhost:5173/api/health` works while `pnpm dev` runs).
- [ ] Server built with `tsc` (no bundler) to `apps/server/dist`; web built to `apps/web/dist`.
- [ ] `env.ts` rejects unknown/missing required vars and is unit-tested.
- [ ] `pnpm db:migrate` fails as an unknown script; nothing in this PR calls it.
- [ ] `pnpm-lock.yaml` committed; `pnpm install --frozen-lockfile` succeeds (PR-03 relies on it).
- [ ] `AGENTS.md` now lists the real commands; `README.md` untouched except any path correction you had to make.

## 8. Test plan

- `src/env.test.ts` —
  prod invariants (TTL > 365, `SECURE_COOKIES=false` + `TRUST_PROXY=true`, open registration over plain HTTP);
  the `.env` loader driven by `DOTENV_PATH` pointing at a temp fixture: file values appear when the process env lacks
  them, a value already in the process env wins, a missing file is a silent no-op, a malformed file throws, and with
  `NODE_ENV=production` the file is never opened at all;
  `databaseUrl()` as a pure function with **no DB involved**: a set `DATABASE_URL` comes back verbatim; unset ⇒ composed
  from `POSTGRES_*` (changing `POSTGRES_PORT` changes the string every host tool will use); `NODE_ENV=production` with
  no `DATABASE_URL` ⇒ fails as a missing required var; a `POSTGRES_PASSWORD` containing a reserved URL character
  (`@ : / + % ? #`) ⇒ fails with a readable error naming the variable.
- `src/app.test.ts` — `app.inject('/api/health')` returns 200.

## 9. Out of scope (do not build)

Any DB code (`db/`, drizzle, migrations, `db:*` scripts), Docker (`docker/`, `Makefile` — PR-02), CI changes (PR-03),
`packages/contracts` (PR-05), any real UI, auth, encryption.

## 10. PR body template

```
Task: PR-01

## What
pnpm monorepo scaffold (apps/server Fastify + apps/web Vite/React/TanStack/Tailwind), Biome + tsc + Vitest gates,
env.ts boot guard with loadDevEnvFile()/databaseUrl(), health routes, AGENTS.md command list.

## Acceptance evidence
- paste: bare-clone `pnpm i && pnpm dev` + `curl :3000/api/health`
- paste: `env -u NODE_ENV node apps/server/dist/index.js` → non-zero
- paste: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
- paste: `pnpm db:migrate` → unknown script

## Docs updated
AGENTS.md (command list), README quick-start path if touched.
```
