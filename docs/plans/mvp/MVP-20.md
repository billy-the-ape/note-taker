# MVP-20 · PR-20 — Documentation & instructions pass (docs-as-code, ADRs, README rewrite)

> **Task ID:** `PR-20` · **Branch:** `docs/pr-20-docs` · **Size:** S (≤ ½ day)
> **Depends on:** PR-18 (structure final) and PR-19 (verification steps known) · **Track:** F Ship
> **Review gate:** M4 — **this PR is the MVP** ("one `docker compose up`, e2e-proven, documented")
> **Docs rule note:** every earlier PR already updated the commands it changed (PR-01 seeded `AGENTS.md`); **this PR
> consolidates** those accumulated edits. It is not the first PR allowed to touch the docs.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~24k tokens** | this brief (2.5k as written, incl. the decision table you must turn into ADRs) + reading the as-built tree (`package.json` scripts, `AGENTS.md`, `docs/{API,DATA-MODEL,DEPLOY}.md`, `README.md`) + the merged PRs' notes to find where the as-built code diverged from the plan |
| **Output** | **~13k tokens** | rewritten `README.md`, `docs/ARCHITECTURE.md`, 5 ADRs, `AGENTS.md` consolidation, `docs/API.md` final sweep, plus this plan folder's cross-links |
| **Session total** | **~37k tokens** | ≈ half an engineer-day of writing plus the time to execute every documented command (`S`, doc-heavy) |

> 1 token ≈ 4 chars; ±30%. Prose is token-dense: budget for one revision pass after a self-review.

---

## 1. Goal

Make the repository self-explanatory: a reader can clone it, run it, deploy it, and understand **why** it is shaped this
way. Every command in the docs must have been executed successfully in the PR environment.

## 2. Repo state you can assume (PR-01…PR-19 merged)

A working app (Fastify + Drizzle + Postgres + React SPA), `docker/{Dockerfile,compose.yml,compose.dev.yml,entrypoint.sh}`,
`Makefile`, `docs/{API.md,DATA-MODEL.md,DEPLOY.md}`, CI with `quality`/`unit`/`build`(+`docker build`)/`integration`
(+`coverage:integration`)/`e2e`, Playwright specs, and a `README.md` that still contains **pre-MVP planning text** (it
currently points at `docs/plans/mvp/MVP-FULL-PLAN.md`). No `docs/adr/`, no `docs/ARCHITECTURE.md` yet.

## 3. Global PR rules

Conventional-commit title (`docs:`); PR body starts `Task: PR-20`; CI green; no code changes except comment/doc fixes;
**no TODO/placeholder left anywhere in the docs**; every relative link resolves.

## 4. Deliverables

### 4.1 Rewrite `README.md`

Replace the planning text with: what it is; quick start (**Docker one-port**, the exact
`docker compose --env-file .env -f docker/compose.yml up -d` form and why both flags are mandatory); local dev
(`cp .env.example .env` / `make db-up` / `pnpm i && pnpm dev`, demo login from `pnpm db:seed`); a configuration table
link (`docs/DEPLOY.md` + `.env.example`); **security notes** — encryption at rest and the key-loss caveat ("losing
`NOTE_ENCRYPTION_KEY` makes note bodies unrecoverable; back it up with the database"), the accepted limitation that
**names/metadata stay plaintext** so search works, and the password-recovery script; a roadmap link to
`docs/plans/mvp/MVP-FULL-PLAN.md` (and the per-task briefs folder); and a short **"what the MVP deliberately does not
do"** list (passkeys, WYSIWYG, trash/history, attachments, multi-user/sharing, SSO/2FA, offline sync, command palette).

### 4.2 Create `docs/adr/` — one ADR per decision

| File | Decision it records |
| --- | --- |
| `0001-storage-in-postgres.md` | Postgres is the single source of truth for metadata **and** content; the FS is only a Postgres volume. Rationale: atomic renames/moves, `user_id` ownership on every row, no path traversal, transactional deletes, trivial backup/restore, composes with at-rest encryption. The folder-tree mental model is preserved logically (`folders.parent_id`) and can be exported later (PR-24). Alternatives rejected: a real FS tree (two sources of truth, rename races), a hybrid (DB+FS), object storage. |
| `0002-encryption-at-rest.md` | AES-256-GCM envelope, `content_cipher bytea` = ciphertext ‖ 16-byte tag, per-write 12-byte IV, `key_version` + explicit `NOTE_ENCRYPTION_KEY_VERSION`, AAD `note:<uuid>`, **no plaintext mode anywhere** (dev/test get a generated key persisted to `.dev/note-key`). Consequences: no Postgres full-text/`pg_trgm` on bodies ⇒ search decrypts in-process (the scale-out path is a per-note encrypted search index, backlog PR-29); **losing the key means the content is gone** (drill in `docs/DEPLOY.md`). Alternatives rejected: Postgres `pgcrypto` (key in the DB), encrypted volume (no per-record crypto), field-level for metadata (kills search). |
| `0003-editor-mode.md` | Raw Markdown buffer + live sanitized preview + Markdown-aware toolbar (CodeMirror 6). Single canonical representation ⇒ no lossy round-trip, trivial autosave/encryption, WYSIWYG can be layered later (PR-22) without changing storage. Alternatives rejected: "basic WYSIWYG" (the README allows either; WYSIWYG is a lossy MD↔doc design), server-side rendering of Markdown. |
| `0004-session-cookies-vs-jwt.md` | DB-backed opaque session tokens (32 random bytes, base64url — the size PR-07 implements), `sha256` at rest, `HttpOnly`/`SameSite=Lax` cookie with `Secure` behind TLS, rotated on login/password change; CSRF double-submit `note_csrf` (`Max-Age` 1 day) + `Origin`/`Sec-Fetch-Site` for the cookieless mutations; a `sessions.user_id` FK makes logout authoritative. Rejected: stateless JWT (revocation needs a blacklist anyway — that is a session with extra steps and key juggling). |
| `0005-pnpm-monorepo.md` | pnpm workspaces, `packages/contracts` as the single source of truth for every payload, one serving port (`@fastify/static` SPA fallback), single Docker image. Rejected: separate repos for client/server (no shared types ⇒ contract drift is invisible until runtime). |

Neither of these gets its own ADR file: the autosave/`version` conflict convention and the
`Ctrl/Cmd+K`-scoped / `Ctrl/Cmd+N`-unbound keyboard rule are pinned in `docs/ARCHITECTURE.md` (§4.3), matching the plan's
§11.4/§11.5 — mention them there, not in an ADR.

### 4.3 Create `docs/ARCHITECTURE.md`

Condensed architecture **as built**, with the deltas from the plan called out: processes and boot order (env → buildApp →
migrate → listen, in one port); the folder/file conventions; the data model summary pointing at `docs/DATA-MODEL.md`;
request path (guard → CSRF → Zod → service → repository, `user_id` scoping in repositories); the encryption boundary
(ciphertext opaque to the repository); the tree safety model (per-user advisory lock, cycle walk, 100-level cap);
autosave/conflict UX (the state machine, the in-flight-snapshot comparison, the ≤ 60 KiB `keepalive` flush and why
`sendBeacon` was rejected); the keyboard map; the tenancy/oracle rule (cross-user id ⇒ 404, including ids in bodies);
and CI (five jobs + the unit-vs-`*.int.test.ts` split + two coverage commands).

### 4.4 Final sweep of `docs/API.md`

Verify every endpoint matches the code (paths, status codes, envelope, `ETag` rules, `CONFLICT` carrying the existing id,
`VERSION_CONFLICT` carrying server `content` + `version`), and that the 22-row contract table is complete.

### 4.5 Consolidate `AGENTS.md`

One coherent command list (`pnpm i / dev / build / build:packages / lint / format / typecheck / test / test:integration /
test:e2e / coverage / coverage:integration / db:generate / db:migrate / db:seed / check:env`, `make db-up db-down
db-reset`) + where the task briefs live (`docs/plans/mvp/`) + the layout conventions from the repo map (single
`newId()`, `*.int.test.ts` naming, `data-testid` rule, the plan/task-brief docs rule, add-only edits in the hotspot files
`apps/server/src/app.ts`, root `package.json`, `db/schema.ts`, `components/ui/*`, `styles/globals.css`).

### 4.6 This plan folder

Keep `docs/plans/mvp/MVP-FULL-PLAN.md` as the historical plan and mark it **implemented**; make sure the
`MVP-01.md … MVP-20.md` briefs and their index (`docs/plans/mvp/README.md`) still resolve, and update any brief whose
instruction the as-built code contradicted.

## 5. Acceptance criteria

- [ ] **Every command in the docs was executed successfully in the PR environment** (paste the transcript list: quick
      start, local dev, seed, `check:env`, backup/restore, rotation `--dry-run`/`--verify`, `reset-password.js`, the test
      commands).
- [ ] No `TODO`/`FIXME`/placeholder left in any doc (grep it).
- [ ] Every relative link between docs resolves — check with a grep for relative links and verify each target exists.
- [ ] 5 ADRs exist with context / decision / consequences / alternatives-rejected, and each maps to a decision the code
      actually implements.
- [ ] `README.md` no longer reads like a pre-MVP planning document; it contains quick start, local dev, security notes,
      the key-loss caveat, and the deliberate-non-goals list.
- [ ] `AGENTS.md`'s command list matches `package.json`/`Makefile` exactly (diff them; a stale command is a bug).
- [ ] `docs/ARCHITECTURE.md` records the **as-built** deltas (not a copy of the plan).

## 6. Out of scope

Feature work (anything functional belongs in a normal PR), i18n, static export of the docs, a marketing site, backlog
items (PR-21…PR-30 in the plan's Track G — list them as roadmap, do not build them).

## 7. PR body template

```
Task: PR-20

## What
README rewrite (quick start / local dev / security + key-loss caveat / non-goals), docs/adr/0001…0005,
docs/ARCHITECTURE.md (as-built deltas), docs/API.md sweep, AGENTS.md command consolidation, plan marked implemented.

## Acceptance evidence
- list of every documented command with its successful run
- grep output: no TODO/placeholder; all relative links resolve
- AGENTS.md command list vs package.json/Makefile diff (empty)
```
