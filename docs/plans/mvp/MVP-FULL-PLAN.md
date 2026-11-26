# Note Taker — MVP Full Plan

> Status: **plan of record** for the initial MVP. Every implementation PR in this repo should cite a PR ID from
> [`§12 Work Breakdown`](#12-work-breakdown--pull-requests).
> Source of requirements: [`README.md`](../../../README.md). This document is the single mapping of the whole
> repository/website and is sliced into one PR per task.
>
> **Per-task briefs live next to this file:** [`MVP-01.md`](MVP-01.md) … [`MVP-20.md`](MVP-20.md)
> (index: [`README.md`](README.md)). Each `MVP-NN.md` is the fully self-contained work order for one PR ID below — it
> duplicates the context it needs, so a coding agent can implement that PR without loading this whole plan.
>
> Last updated: MVP planning phase, before any application code exists.

---

## Table of contents

1. [How to use this document](#1-how-to-use-this-document)
2. [Product definition](#2-product-definition)
3. [Scope: MVP vs. post-MVP](#3-scope-mvp-vs-post-mvp)
4. [Answers to the open questions in README.md](#4-answers-to-the-open-questions-in-readmemd)
5. [Stack decision](#5-stack-decision)
6. [Architecture overview](#6-architecture-overview)
7. [Target repository map](#7-target-repository-map)
8. [Data model](#8-data-model)
9. [HTTP API contract](#9-http-api-contract)
10. [Security model (incl. encryption at rest)](#10-security-model-incl-encryption-at-rest)
11. [Frontend architecture (routes, state, autosave, editor)](#11-frontend-architecture-routes-state-autosave-editor)
12. [Work breakdown — pull requests](#12-work-breakdown--pull-requests)
13. [Dependency graph & parallel execution tracks](#13-dependency-graph--parallel-execution-tracks)
14. [CI design (replaces the placeholder workflow)](#14-ci-design-replaces-the-placeholder-workflow)
15. [Docker / self-hosting runbook](#15-docker--self-hosting-runbook)
16. [Configuration reference](#16-configuration-reference)
17. [Testing & verification strategy](#17-testing--verification-strategy)
18. [Definition of Done for the MVP](#18-definition-of-done-for-the-mvp)
19. [Requirements traceability matrix](#19-requirements-traceability-matrix)
20. [Risks & mitigations](#20-risks--mitigations)
21. [Open questions for the product owner](#21-open-questions-for-the-product-owner)
22. [Appendix A — concrete implementation sketches](#appendix-a--concrete-implementation-sketches)

---

## 1. How to use this document

- **One PR = one task ID** (`PR-01` … `PR-20`). Task IDs are stable; do not renumber.
- **Each task is also a standalone work order:** `docs/plans/mvp/MVP-01.md` … `MVP-20.md` (index:
  `docs/plans/mvp/README.md`). A brief restates everything its PR needs — context, contracts, acceptance — so the agent
  coding that PR never has to load this file (each brief is 1.1k–5.2k tokens; this file is ~50k). Each brief also carries
  its own estimated input/output token cost near the top. When a PR changes a decision recorded here, update both this
  file and the affected brief(s) in the same PR.
- Each task lists: goal, dependencies, *in-scope* files, acceptance criteria, test plan, size (`S` ≤ ½ day,
  `M` = 1–2 days, `L` = 3–4 days). Sizes are for one engineer familiar with the stack.
- **Merge order:** any task may be opened as soon as its dependencies are merged. Where a task only needs the
  *shape* of another task's output (e.g. UI needing API payloads), build against
  `packages/contracts` (PR-05) and mock handlers instead of waiting — see [§13](#13-dependency-graph--parallel-execution-tracks).
- Every PR must keep CI green (lint + typecheck + tests + coverage gate) and update the docs it invalidates
  (`README.md`, `docs/ARCHITECTURE.md`, ADRs) in the same PR — required by [`AGENTS.md`](../../../AGENTS.md).
- Any decision in [§4](#4-answers-to-the-open-questions-in-readmemd) that a PR needs to change must add a new
  ADR under `docs/adr/` and update this file's decision table in the same PR.

---

## 2. Product definition

**Note Taker** is a small, self-hostable web app for writing and organizing Markdown notes in a folder tree.

Primary user story (the MVP must satisfy all of it in one session):

1. Open the app in a browser (no CDN, no external account) → see a login/setup screen.
2. Create an account (username + password) on first run, then log in/out.
3. Create folders, rename folders, nest folders, delete folders.
4. Create a note → a **name is asked for**, pre-populated as `new-file-<msepoch>.md`, extension `.md` **not editable**.
5. Edit the note in a Markdown editor; formatting available via toolbar and/or raw Markdown with live preview.
6. **Autosave is on by default** — edits persist without a save button; a visible status indicator shows saved/saving/error.
7. Rename a note, move it to another folder, delete it.
8. Notes and folders survive restarts, are stored efficiently and securely (encrypted at rest), and the whole
   deployment is `docker compose up` with **one published port**.

Non-functional targets:

| Attribute | Target |
| --- | --- |
| Deployment | One Docker image + Postgres, single port (default `3000`) |
| Cold start | Container healthy and serving in < 10 s (excluding first DB init) |
| Persistence | No lost keystrokes within the autosave window; crash-safe (server is the source of truth) |
| Security | Passwords hashed with argon2id; session cookies `HttpOnly`/`SameSite=Lax`, plus `Secure` behind TLS (`SECURE_COOKIES=true`: off by default in dev, refused by the boot guard when `TRUST_PROXY=true` or registration is open — §10/§16); note bodies encrypted at rest (AES-256-GCM); ownership enforced on every query |
| Code quality | 100% typechecked (TS `strict`), zero lint errors, unit + integration tests with enforced coverage floor |
| Data scale assumption | Single-user / small-team: thousands of notes, ~10⁴ folders; in-process search is acceptable |

---

## 3. Scope: MVP vs. post-MVP

### 3.1 In the MVP (shipped by PR-20)

- Username + password auth (first-run `/setup`, owner-created accounts via `POST /api/users`, and — only when
  `ALLOW_REGISTRATION=true` — self-service sign-up via `POST /api/auth/register`), login, logout, change password.
- Session-based auth with DB-backed sessions and cookie transport.
- Folder tree: create, rename, move, delete (with explicit cascade confirmation), nesting up to a server-enforced
  100-level cap (enforced at create/move, not silently truncated — §9.2 #13/#14, PR-09), cycle-safe.
- Notes: create (name prompt with `new-file-<msepoch>.md` prefill, fixed `.md`), rename, move, delete.
- Markdown editing: raw Markdown buffer + toolbar that inserts/wraps Markdown, live preview pane (toggle: split / write / preview).
- Autosave on by default, with per-user setting, dirty/saved/conflict status, offline-ish buffering of the last unsaved buffer.
- Optimistic-concurrency on note content (`version`) so two tabs do not silently overwrite each other.
- Encryption of note bodies at rest (AES-256-GCM, envelope with `key_version`), key generation + rotation scripts.
- Full-text-ish search over note names + decrypted bodies (in-process filter) — cheap at MVP scale.
- Per-user settings: autosave on/off, theme (light/dark/system).
- Docker (dev + prod), migrations run on start, health endpoint, structured logs, graceful shutdown.
- CI: lint, format check, typecheck, unit tests with coverage, integration tests against real Postgres, Docker build smoke.
- Playwright smoke suite (login → create folder → create note → type → reload → content persists).
- Docs: `README.md` rewrite (usage + self-host), `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, ADRs.

### 3.2 Explicitly NOT in the MVP (backlog, §12 Track G)

- **Passkeys / WebAuthn** (README marks it optional; it is more than "a few lines") → `PR-21` in backlog.
- WYSIWYG ("Word-style") editing with TipTap/ProseMirror, or rich-text ↔ Markdown round-tripping → `PR-22`.
- Notes as literal files on a mounted volume / bidirectional FS sync, ZIP export-import.
- Trash / undo-delete, note history/versions UI, pinning, tags, favorites, drag-and-drop (MVP moves via dialog).
- Command palette, keyboard-only UX, mobile-specific layout polish, PWA/offline IndexedDB sync.
- Multi-workspace / shared folders / permissions beyond "owner", email magic links, 2FA, SSO/OIDC.
- Attachments/images (upload + storage), Mermaid/KaTeX rendering, syntax highlighting themes beyond the default.
- Observability beyond logs (metrics/tracing), backups automation, horizontal scaling.
- i18n, SSR, static export of the SPA.

---

## 4. Answers to the open questions in README.md

README leaves six design questions open. Five ADRs in `docs/adr/` (written in PR-20) capture them — ADR-0001 ← Q2,
ADR-0002 ← Q1, ADR-0003 ← Q3, ADR-0005 ← Q6, plus ADR-0004 from the §5 session decision; Q4 and Q5 are conventions
pinned in §11.4 and §11.5 instead of separate ADRs;
the *recommended default* is what the PRs implement — see [§21](#21-open-questions-for-the-product-owner) if any need revisiting.

| # | README question | Decision | Rationale / trade-off |
| --- | --- | --- | --- |
| Q1 | "Backend stores saved notes efficiently & securely. 2 way encrypted?" | **Yes — authenticated encryption at rest.** `notes.content_cipher` stored as `bytea`, AES-256-GCM, per-record 12-byte random IV, master key from `NOTE_ENCRYPTION_KEY` (base64, 32 bytes), `key_version` column enables rotation. ADR-0002. | Deterministic/simple; decryption only in the API process; ciphertext+tag in one column (the tag is appended by `seal()` from `cipher.getAuthTag()`; `node:crypto` never appends it itself). Trade-off: no Postgres `FULLTEXT`/`pg_trgm` on bodies → search decrypts in-process (fine at MVP scale). If `NOTE_ENCRYPTION_KEY` is missing the app **refuses to start**; there is no plaintext mode (§10) — development and test get a generated key persisted to `.dev/note-key` so dev rows survive restarts. |
| Q2 | "Folders and notes persistence: Raw file system? or database?" | **Postgres is the single source of truth** for both metadata and content. FS is only a container volume for Postgres data. ADR-0001. | A folder tree in a DB gives atomic renames/moves, ownership enforcement via `user_id` on every row, no path-traversal surface, no FS permission pain in containers, transactional deletes, trivial backup/restore, and it composes with at-rest encryption. Keeping a real FS tree *and* a DB means two sources of truth and rename races. The "folder structure" mental model is preserved logically (`folders.parent_id`) and can be exported later (`PR-24`). |
| Q3 | Editor: "word style (toolbar)" **or** "raw markdown + preview" | **Raw Markdown buffer + live preview + Markdown-aware toolbar** (the second option, plus toolbar affordances from the first). ADR-0003. | Single canonical representation (the Markdown text) → no lossy round-trip, autosave is trivial, encryption is trivial, WYSIWYG can be layered on later (`PR-22`) without changing storage. CodeMirror 6 gives selection APIs the toolbar needs. |
| Q4 | "Auto-save can be enabled (default on)" | Autosave **default on**, debounced 1200 ms, force-flush ≤ every 10 s and on navigation/blur/unload, plus `Ctrl/Cmd+S`; per-user setting; conflict handled with `version` + explicit UI (§11.4). | Meets the README requirement and prevents the classic autosave data-loss mode (two tabs). |
| Q5 | "File names are auto generated as `new-file-<msepoch>.md`" | Generate `new-file-<Date.now()>.md` client-side, shown in a create dialog with the `.md` **suffix rendered but not editable**; the server validates and, if the name is taken in that folder, either returns `409` (dialog inline error) or auto-uniquifies when the API is called without an explicit name. `notes.name` stores the name **without** `.md`; the extension is appended at display time only. | Keeps one rule in one place (`packages/contracts/src/names.ts`) shared by client and server. |
| Q6 | Framework choice | **Node 22 + TypeScript + Fastify 5 + Drizzle + Postgres 16 + React 19 + Vite + Tailwind v4 + TanStack Router/Query + Zod** (pnpm monorepo, single serving port). §5. | Directly matches the owner's stated preference; the only additions are Fastify (not named in README) and CodeMirror for the editor. |

---

## 5. Stack decision

**Chosen (all pinned by `package.json`, no floating majors):**

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript 5.x `strict`, ESM everywhere | LTS line; native `fetch`, `crypto`; the exact version is pinned by `.nvmrc` + the Dockerfile base image, not by prose |
| Package mgmt | pnpm workspaces (version pinned via `packageManager` in the root `package.json`), `pnpm dev/build/test` scripts | Fast, strict deps, workspace linking for `packages/contracts` |
| Server | Fastify 5 + `fastify-type-provider-zod` | Small, typed routes via Zod (README's zod preference), first-class plugins, `@fastify/static` for SPA hosting on one port |
| DB | Postgres 16 + `drizzle-orm` + `postgres` (postgres.js) driver + `drizzle-kit` | README preference; typed schema + committed SQL migrations |
| Validation | Zod v4 in `packages/contracts`, shared client/server | One definition of every payload, and it drives the client API types |
| Auth | `@node-rs/argon2` (argon2id) + opaque DB-backed session tokens + `@fastify/cookie` + CSRF double-submit token | README's "very basic auth"; opaque sessions beat JWT here (instant revocation, no key juggling) — ADR-0004 |
| Client | React 19 + Vite 7 + TanStack Router (file-based routes) + TanStack Query | README preference; Router gives typed params + route guards for auth |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) + `clsx` + a thin `Button/Input/Dialog` set (Radix primitives) | README preference; Radix dialogs/menus give a11y for free without a design system |
| Editor | CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/lang-markdown`) + `react-markdown` + `remark-gfm` + `rehype-sanitize` | Markdown language mode, selection APIs for the toolbar, sanitized preview |
| Testing | Vitest (`@vitest/coverage-v8`) unit + integration (real Postgres), Playwright e2e | README's CI minimum + real end-to-end proof |
| Quality | Biome (lint + format + import sorting) + `tsc --noEmit` | One fast tool replaces ESLint+Prettier; keeps CI cheap |
| Infra | Docker multi-stage image, `docker compose` (app + db), `node --watch`/`tsx` for dev | README: "Docker, assigned to a port" |

**Rejected alternatives (kept for the record):** Next.js (SSR unnecessary for a private single-port app and
complicates one-container serving), SQLite (Postgres is the stated preference and better for concurrent writes;
SQLite would be a *nice* single-image option — revisit only if the owner wants zero external services, then use
`libsql`/`better-sqlite3` behind the same repository interfaces), raw `express` (no typed routes),
Prisma (Drizzle preferred in README), JWT access tokens (see ADR-0004), TipTap in MVP (§3.2).

---

## 6. Architecture overview

```
┌───────────────────────────── browser (React SPA, same origin) ─────────────────────────────┐
│ TanStack Router  : /login  /setup  /app  /app/note/$noteId  /app/settings  /app/search     │
│ TanStack Query   : server state (tree, note content, settings) + optimistic mutations      │
│ autosave engine  : debounce(1200ms) + flush(10s | blur | unload | route change) + version  │
└───────────────┬─────────────────────────────────────────────▲──────────────────────────────┘
                │ JSON over /api/*, cookie session + CSRF     │ typed by packages/contracts (Zod)
┌───────────────▼───────────────────────────── apps/server ───┴──────────────────────────────┐
│ Fastify 5  ·  plugins: session/auth guard, CSRF, zod validator, error envelope, pino,      │
│              static SPA fallback (single port)                                             │
│ routes  → services (domain rules) → repositories (Drizzle) → Postgres                      │
│ crypto  → envelope encrypt/decrypt (AES-256-GCM, key_version) applied in note repository   │
└──────────────────────────────────────────────┬────────────────────────────────────────────┘
                                               │ DATABASE_URL
                                     ┌─────────▼─────────┐
                                     │ Postgres 16 (vol) │  ← only persistent volume
                                     └───────────────────┘
```

Process model: **one Node process** serves the API *and* the built SPA (`@fastify/static` + SPA fallback for
non-`/api` GETs) → satisfies "assigned to a port". Migrations run at container start before `listen()`.
Dev mode runs two processes (`vite` on `5173` proxying `/api` to `3000`, plus `tsx watch`).

---

## 7. Target repository map

The full target tree (every file is created by exactly one PR; PR ID in the right column). Files that already
exist are marked *(exists)*.

```
note-taker/
├── README.md                                  (exists) rewritten in PR-20 (usage + self-host + roadmap)
├── AGENTS.md / CLAUDE.md / .clinerules/*       (exists) — each PR that changes a command/layout updates AGENTS.md in that same PR (§1 rule); PR-20 does the consolidation pass
├── .github/
│   └── workflows/
│       ├── CI.yml                             (exists, placeholder) REPLACED in PR-03
│       │                                      ⚠ keep `name: CI` — claude-review.yml triggers on it
│       └── claude-review.yml                  (exists) untouched
├── .editorconfig  .gitignore  .dockerignore  .nvmrc  LICENSE      PR-01
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  PR-01
├── .env.example                               PR-01 (ships `NODE_ENV=development`), extended by PR-02
│                                            (dev DB vars) and PR-06/PR-18 (key + prod vars) — §16
├── Makefile                                   PR-02 (dev/db/build/test entry points)
├── docs/
│   ├── plans/mvp/MVP-FULL-PLAN.md             (this file)
│   ├── plans/mvp/README.md                    (index of the task briefs below)
│   ├── plans/mvp/MVP-01.md … MVP-20.md        (self-contained work order per PR; this file is the source)
│   ├── ARCHITECTURE.md                        PR-20
│   ├── DEPLOY.md                              PR-18
│   ├── API.md                                 PR-05 (generated-ish reference of §9)
│   ├── DATA-MODEL.md                          PR-04
│   └── adr/
│       ├── 0001-storage-in-postgres.md        PR-20
│       ├── 0002-encryption-at-rest.md         PR-20
│       ├── 0003-editor-mode.md                PR-20
│       ├── 0004-session-cookies-vs-jwt.md     PR-20
│       └── 0005-pnpm-monorepo.md              PR-20
├── docker/
│   ├── Dockerfile                             PR-18  (multi-stage, non-root, HEALTHCHECK)
│   ├── compose.yml                            PR-18  (app + db, one published port)
│   ├── compose.dev.yml                        PR-02  (db only)
│   └── entrypoint.sh                          PR-18  (exec node only — env checks + migrations run inside the compiled bootstrap)
├── scripts/                                   DEV/CI ONLY — never shipped, never the way an operator does anything
│   ├── generate-keys.ts                       PR-06  (prints a fresh key to stdout; dev/CI only — operators use the §15 `docker run` one-liner)
│   ├── seed-demo.ts                           PR-09  (demo user + sample tree; guarded by NODE_ENV ≠ production)
│   └── check-env.ts                           PR-18  (dev/CI fail-fast on missing/prod-unsafe env; the same rules live in the compiled `env.ts` at boot)
│                                              Operator scripts live under apps/server/src/scripts/ (see below) so they
│                                              are compiled into `dist/` and can run inside the production image.
├── packages/
│   └── contracts/                             PR-05  (no runtime deps except zod)
│       ├── package.json  exports/main/types → ./dist  ·  tsconfig.json  outDir: dist, declaration
│       ├── vitest.config.ts                 PR-05  (unit scope in §14; contracts needs no DB)
│       └── src/
│           ├── index.ts                       barrel export
│           ├── api-envelope.ts                ApiErrorCode, errorResponseSchema, paginated/list helpers
│           ├── auth.schemas.ts                registerSchema, loginSchema, sessionUserSchema, changePasswordSchema
│           ├── tree.schemas.ts                folderNodeSchema, noteNodeSchema, treeResponseSchema
│           ├── notes.schemas.ts               createNoteSchema, renameMoveSchema, contentUpdateSchema, noteSchema
│           ├── folders.schemas.ts             createFolderSchema, patchFolderSchema, deleteOptionsSchema
│           ├── settings.schemas.ts            settingsSchema, patchSettingsSchema
│           ├── search.schemas.ts              searchQuerySchema, searchResultSchema
│           ├── names.ts                       NOTE_NAME rules + newFileName(msEpoch) + stripMd()/withMd()
│           ├── routes.ts                      ROUTES path constants shared by client & server
│           └── *.test.ts                      unit tests (name rules, uniqueness suffixing, validation edges)
└── apps/
    ├── server/                                Fastify + Drizzle
    │   ├── package.json  tsconfig.json  tsconfig.build.json   PR-01 (`build` compiles this one, so `dist` has no tests)
    │   ├── drizzle.config.ts                  PR-04
    │   ├── vitest.config.ts (unit: PR-01)  vitest.integration.config.ts (PR-04)
    │   ├── migrations/                        PR-04 (committed SQL, generated by drizzle-kit)
    │   └── src/
    │       ├── index.ts                       PR-01 (bootstrap: env → buildApp → migrate → listen → shutdown)
    │       ├── app.ts                         PR-01 factory `buildApp(deps)` — DI so tests never bind a port
    │       ├── env.ts                         PR-01 zod-parsed process.env, prod invariants, `loadDevEnvFile()`
    │       │                                  and `databaseUrl()` (§16)
    │       ├── logger.ts                      PR-01 pino
    │       ├── db/schema.ts                   PR-04 drizzle table definitions (single source of truth)
    │       ├── db/client.ts                   PR-04 postgres.js pool + drizzle instance
    │       ├── db/migrate.ts                  PR-04 programmatic migration runner
    │       ├── db/repositories/users.repo.ts       PR-07
    │       ├── db/repositories/sessions.repo.ts    PR-07
    │       ├── db/repositories/folders.repo.ts     PR-04 (harness) → final form in PR-09
    │       ├── db/repositories/notes.repo.ts       PR-04 (opaque bytea triples) → crypto wired in PR-06/09
    │       ├── db/repositories/settings.repo.ts    PR-09
    │       ├── db/repositories/*.int.test.ts  integration (real DB) — the `.int.` suffix is what keeps it out of `pnpm test` (§14)
    │       ├── crypto/envelope.ts             PR-06 encrypt/decrypt AES-256-GCM
    │       ├── crypto/keys.ts                 PR-06 keyring from env (current + previous versions)
    │       ├── crypto/envelope.test.ts        PR-06 roundtrip, tamper, wrong key, rotation
    │       ├── scripts/rotate-note-key.ts     PR-06 operator script — compiled into `dist/scripts/`, runs INSIDE the image
    │       ├── scripts/reset-password.ts      PR-07 operator script — same; the only supported password recovery
    │       ├── plugins/auth-guard.ts          PR-07 session resolution + `requireAuth` preHandler
    │       ├── plugins/error-handler.ts       PR-05 zod/Drizzle/domain errors → envelope
    │       ├── plugins/csrf.ts                PR-07 cookie-to-header double submit
    │       ├── plugins/static-spa.ts          PR-12 serve ../web/dist + SPA fallback (skip /api)
    │       ├── http/rate-limit.ts             PR-07 in-memory sliding window (login)
    │       ├── services/auth.service.ts       PR-07
    │       ├── services/folder.service.ts     PR-09 rename/move/cycle guard/cascade
    │       ├── services/note.service.ts       PR-09/PR-10 create, content update + version, rename/move
    │       ├── services/tree.service.ts       PR-09 recursive CTE tree assembly
    │       ├── services/settings.service.ts   PR-09 (get/patch; consumed by PR-14 and the PR-16 UI)
    │       ├── services/search.service.ts     PR-11
    │       ├── routes/health.routes.ts        PR-01
    │       ├── routes/auth.routes.ts          PR-07
    │       ├── routes/users.routes.ts         PR-07 (admin create/list when registration closed)
    │       ├── routes/tree.routes.ts          PR-09
    │       ├── routes/folders.routes.ts       PR-09
    │       ├── routes/notes.routes.ts         PR-09 + PR-10
    │       ├── routes/search.routes.ts        PR-11
    │       ├── routes/settings.routes.ts      PR-09 (consumed by PR-16 UI)
    │       ├── routes/*.int.test.ts           integration through `buildApp` + `app.inject()`
    │       ├── domain/errors.ts               PR-05 typed domain errors
    │       ├── domain/name.ts                 PR-09 server-side wrapper around contracts `names.ts`
    │       └── test/                          PR-04 helpers: `withDb()`, `withApp()`, `fixtures.ts`
    └── web/                                   Vite + React SPA
        ├── package.json  tsconfig.json  vite.config.ts  index.html  vitest.config.ts   PR-01 (proxy target: VITE_API_TARGET)
        ├── playwright.config.ts               PR-19
        ├── e2e/                               PR-19 auth.spec.ts, notes.spec.ts, autosave.spec.ts,
        │                                    folders.spec.ts, db.ts (test-only postgres.js reader, scenario 7)
        └── src/
            ├── main.tsx                       PR-01 (Router + QueryClient + providers)
            ├── styles/globals.css             PR-01 (Tailwind v4 @theme tokens)
            ├── routes/__root.tsx              PR-01
            ├── routes/index.tsx               PR-01 placeholder → redirect rule finalized in PR-08
            ├── routes/login.tsx               PR-08
            ├── routes/setup.tsx               PR-08 first-run account creation
            ├── routes/welcome.tsx             PR-08 signed-in placeholder home (deleted by PR-12)
            ├── routes/signup.tsx              PR-08 self-sign-up form (only when `registrationOpen` AND `!needsSetup`)
            ├── routes/app/route.tsx           PR-12 layout route (auth guard + AppShell outlet)
            ├── routes/app/index.tsx           PR-12 "no note selected" / recent notes
            ├── routes/app/note.$noteId.tsx    PR-13/14 editor page
            ├── routes/app/settings.tsx        PR-16
            ├── routes/app/search.tsx          PR-17
            ├── lib/api.ts                     PR-05 typed fetch wrapper (+ error mapping, CSRF header,
            │                                   one-shot 403 refresh-and-replay per §10; proven in PR-07)
            ├── lib/queryClient.ts             PR-05
            ├── lib/markdown.ts                PR-13 toolbar transforms (pure, unit-tested)
            ├── lib/autosave.ts                PR-14 state machine (pure, unit-tested) owns the buffer
            ├── lib/draft.ts                   PR-14 the `note-draft:<id>` crash mirror (not a `uiStore` key)
            ├── lib/name.ts                    PR-15 thin wrapper over contracts names.ts
            ├── features/auth/{session.tsx, auth.api.ts, useSession.ts}   PR-08
            ├── features/tree/{tree.queries.ts, tree.selectors.ts, tree.mutations.ts}  PR-12
            ├── features/notes/{note.queries.ts, note.mutations.ts}       PR-13/14
            ├── features/notes/{new-note.ts, open-note.ts}  PR-15 the create path (tree-cache uniqueness,
            │                                            cache bookkeeping) and the editor-caret handoff
            ├── features/notes/useAutosave.ts  PR-14 the machine's DOM half (flush triggers, draft prompt)
            ├── features/settings/settings.api.ts PR-14 `GET /api/settings` read (PR-16 grows the screen)
            └── components/
                ├── ui/{Button,Input,Field,Dialog,Menu,Toast,Spinner}.tsx  PR-08 (grown by later PRs)
                ├── layout/{AppShell,Sidebar,TopBar,StatusBar}.tsx         PR-12
                ├── tree/{FolderTree,FolderRow,NoteRow,TreeContextMenu}.tsx PR-12
                ├── editor/{EditorPane,MarkdownEditor,EditorToolbar,PreviewPane}.tsx PR-13
                ├── editor/{SaveStatus,ConflictBanner,DraftPrompt}.tsx     PR-14
                ├── notes/{RenameDialog,MoveDialog,DeleteConfirm}.tsx      PR-12 (shared dialog forms)
                └── notes/NewNoteDialog.tsx                               PR-15
```

Rules the map enforces:

- **No import from `apps/web` into `apps/server`** (except the static file path at build time) and vice versa;
  the only shared code is `packages/contracts`.
- Route handlers stay thin (validate → call service → map result); domain rules live in `services/`; SQL lives in
  `db/repositories/`. This is what makes PR-09/PR-10 testable without HTTP.
- Anything a UI test needs to assert gets a `data-testid` in the components above (PR-19 relies on it).

---

## 8. Data model

Postgres 16. Drizzle schema is the source of truth; `drizzle-kit generate` produces committed SQL in
`apps/server/migrations/`. UUID PKs — **UUIDv7 preferred** (one `newId()` helper wrapping `uuid`'s `v7` — the
scoped `@uuidjs/uuid-v7` named here before PR-04 has never been published, so PR-04 shipped `uuid` and corrected
this line);
Node's `crypto.randomUUID()` is **v4** and is an acceptable fallback because nothing in the MVP orders rows by id.
Either way there is exactly one `newId()`, and every insert goes through it.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() fallback for defaults

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  username          text NOT NULL,                       -- compared case-insensitively via unique index
  password_hash     text NOT NULL,                       -- argon2id encoded string
  display_name      text,
  role              text NOT NULL DEFAULT 'member'     -- 'owner' | 'member' (multi-user later).
                    CHECK (role IN ('owner','member')), -- LEAST-privilege on purpose: with the one-owner
                                                       -- index below, an insert that forgets the column must
                                                       -- never mint an owner (or a second such row would die on
                                                       -- that index). Only /setup writes 'owner', explicitly.
  password_set_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
-- Exactly one owner, enforced by the DB instead of a read-then-insert race: a second concurrent /setup attempt (or a
-- second operator who guessed the URL) hits this index and gets CONFLICT, so two owners are impossible even under a
-- race. Owned by PR-04's schema; PR-07's acceptance includes the concurrent-setup test. This index is also why the
-- column default above is 'member': a DEFAULT 'owner' would turn every role-less insert (fixtures, register,
-- POST /api/users) into an owner attempt, so the second one would fail with a unique violation that looks like a
-- bug in the index rather than a missing column. Services still pass `role` explicitly and never lean on the default.
CREATE UNIQUE INDEX users_one_owner_uidx ON users (role) WHERE role = 'owner';

CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,                         -- sha256(session_token); raw token only in the cookie
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE folders (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES folders(id) ON DELETE CASCADE,   -- NULL = root. The cycle check (PR-09) runs in a transaction that FIRST takes pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text)) — one lock per user serializes folder create/move/delete. Locking only the two affected rows is not enough: two moves can lock disjoint pairs (X→Y and Z→W), each pass its own ancestor walk, and commit a cycle
  name       text NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX folders_unique_sib ON folders (user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX folders_user_parent_idx ON folders(user_id, parent_id);

CREATE TABLE notes (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id         uuid REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = root (nullable, mirrors folders.parent_id)
  name              text NOT NULL CHECK (name <> ''),       -- WITHOUT the ".md" suffix
  version           integer NOT NULL DEFAULT 1,             -- bumped on every content write (optimistic concurrency)
  content_cipher    bytea NOT NULL,                       -- AES-256-GCM ciphertext || 16-byte tag; NEVER a plain-text default
  content_iv        bytea NOT NULL,                       -- 12 bytes, per-write random (no default: an empty IV is undecryptable)
  key_version       integer NOT NULL DEFAULT 1,
  content_format    text NOT NULL DEFAULT 'markdown',
  content_bytes     integer NOT NULL DEFAULT 0,             -- plaintext byte length (for listings, no decrypt)
  word_count        integer NOT NULL DEFAULT 0,
  content_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notes_unique_sib ON notes (user_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX notes_user_folder_idx ON notes(user_id, folder_id);
CREATE INDEX notes_user_content_updated_idx ON notes(user_id, content_updated_at DESC);  -- "recent notes"

CREATE TABLE settings (                  -- 1 row per user, inserted in the SAME transaction as the users row (PR-07);
                                         -- settings.service.get() get-or-creates as the belt for rows made outside it
                                         -- (PR-04 fixtures, seeds, restores). No trigger exists in this schema.
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  autosave   boolean NOT NULL DEFAULT true,
  theme      text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_attempts (            -- durable rate-limit / lockout evidence (PR-07)
  id          uuid PRIMARY KEY,
  user_key    text NOT NULL,            -- lower(username) or ip
  succeeded   boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key_at_idx ON auth_attempts(user_key, at DESC);
```

### Invariants enforced (and by whom)

| Invariant | Enforcement |
| --- | --- |
| Every folder/note belongs to exactly one user | `user_id` NOT NULL + `WHERE user_id = auth.userId` on **every** repository query; cross-user access returns `404`, never `403` (no enumeration). **This applies to ids arriving in bodies too** (`POST /api/notes {folderId}`, `POST /api/folders {parentId}`, `PATCH … {parentId\|folderId}`): the FKs (`notes.folder_id → folders.id`, `folders.parent_id → folders.id`) do **not** carry `user_id`, so the service must load the target folder scoped to `auth.userId` and answer `404 NOT_FOUND` before inserting/moving — otherwise user A could attach rows into user B's tree, probe folder ids through FK violations, and lose rows in B's cascade delete. (Backlog alternative: composite `(user_id, id)` unique + FKs — see §12 PR-09 create list.) |
| Sibling names unique (case-sensitive, trimmed, no `/`, no control chars, ≤ 120 chars) | DB unique index + Zod refinements in `contracts` |
| Note name never contains the `.md` extension in the DB | `stripMd()` in `contracts/names.ts` (display adds it back via `withMd()`), applied in `note.service.ts` — and enforced, not assumed: `isValidNoteName` **rejects any stripped name that still ends in `.md`** (case-insensitive), so one strip is provably enough. Without that rule `foo.md.md` stores as `foo.md`, renders identically to the stored note `foo`, and a rename prefill silently loses characters (A.1; PR-05 contract tests) |
| A folder cannot be moved inside itself | `folder.service.ts` CTE ancestor walk → `CONFLICT`, inside the per-user `pg_advisory_xact_lock` transaction (§8 `folders.parent_id` comment, PR-09) — row locks alone leave a four-node cycle reachable |
| `note.version` monotonic | conditional `UPDATE … WHERE id = $1 AND version = $2 RETURNING` → 0 rows ⇒ `409` |
| Deleting a folder removes descendants | `ON DELETE CASCADE`, gated by explicit `?cascade=true` in the API |
| Notes **and** folders may live at the root of the tree | `notes.folder_id` and `folders.parent_id` are both nullable, `NULL` = root; the `COALESCE`-based unique indexes above keep sibling names unique for root-level rows too |
| Note content is never stored in plaintext — in **any** environment | `crypto/envelope.ts` is the only writer of `content_cipher`; `env.ts` guarantees a key everywhere (production hard-fails without one, dev/test get a key persisted to `.dev/note-key`, §10). There is no plaintext column, flag, or code path to forget |
| Every user has exactly **one** `settings` row | Inserted by the same transaction as the `users` insert in every account-creating path (`setup`, `register`, `POST /api/users`) — that is PR-07's job because PR-07 owns them and merges before anything reads settings. `settings.service.get()` then get-or-creates (`INSERT … ON CONFLICT (user_id) DO NOTHING`, then select) as the belt for rows made outside those paths, so `GET /api/settings` can't 404 and `PATCH /api/settings` can't match 0 rows (PR-09); `user_id` being the PK is what makes "exactly one" structural |
| Every note row has a **decryptable** content triple | `note.service.create` always calls `sealNoteContent(content ?? '')`, so a content-less `POST /api/notes` still stores a real 12-byte IV + 16-byte tag for the empty string; `openNoteContent()` never sees empty `content_cipher`/`content_iv` (a 0-byte IV makes GCM throw and surface as `INTERNAL`) |
| The install has an **owner** before anyone else can join | `auth.service.ts` refuses `POST /api/auth/register` with `FORBIDDEN` while no `role='owner'` row exists, and `needsSetup` is defined as “no owner row”, so a self-sign-up can never occupy the empty DB and lock `/setup` out (§9.2 #2–#4). `users_one_owner_uidx` keeps the other half: at most one owner |

No soft-delete/trash in the MVP (backlog `PR-23`); deletes are hard, guarded by a typed confirmation dialog
(type the folder/note name) so accidental cascade deletes require deliberate typing.

---

## 9. HTTP API contract

Base path `/api`. Content type `application/json; charset=utf-8`. All bodies validated with the Zod schemas in
`packages/contracts` via `fastify-type-provider-zod`, so `docs/API.md`, the server, and the client share one truth.

### 9.1 Error envelope (every non-2xx)

```jsonc
{ "error": { "code": "CONFLICT", "message": "name already exists in this folder",
             "details": [{ "path": "name", "message": "must be unique among siblings" }],
             "data": { "id": "0f6f0c1a-…" }, "requestId": "…" } }
```

A sibling-name clash is always `CONFLICT` (409), never `VALIDATION` — see §9.2 notes and PR-09. `VALIDATION` (400)
is reserved for malformed payloads (bad characters, length, missing fields).

`code ∈ VALIDATION | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | VERSION_CONFLICT |
PAYLOAD_TOO_LARGE | INTERNAL`. Mapped centrally in `plugins/error-handler.ts` from typed domain errors in
`domain/errors.ts`. Postgres concurrency errors — `40001` (serialization failure) and `40P01` (deadlock detected) — map
to `CONFLICT` (409) as well: they are retryable by the client and must never surface as an unexplained `INTERNAL`. PR-05
wires that mapping; PR-09's folder-move design takes exactly one advisory lock per user precisely so `40P01` is not
reachable there (§8, PR-09). `requestId` is echoed in logs for support.

`data` is an **optional, code-specific payload object** — the only place structured extras travel, so `details` stays a
list of field errors. `CONFLICT` from a duplicate create carries `data: { id }` (the existing row, the id referenced by
the idempotency rule in §9.3), and `VERSION_CONFLICT` carries `data: { content, version }` (the current server plaintext
plus version, which §11.4's autosave engine compares against the snapshot it sent). Every other code omits `data`.
PR-05 pins the field names in the envelope schema and `docs/API.md`; PR-09, PR-10 and PR-14 read them.

### 9.2 Endpoints

| # | Method + path | Auth | Request (contract schema) | Success response | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /api/health` | none | — | `{status:'ok', db:'ok', version}` | also `GET /api/healthz` for the Docker `HEALTHCHECK` |
| 2 | `GET /api/auth/status` | none | — | `{needsSetup:boolean, registrationOpen:boolean}` | `needsSetup` true iff **no `role='owner'` row** exists (not merely “`users` is empty”: a stray `member` must not flip it, see #4) → client routes to `/setup`; `registrationOpen` mirrors `ALLOW_REGISTRATION` → `/login` can offer "Create account" |
| 3 | `POST /api/auth/setup` | none, **only when `needsSetup`** | `registerSchema {username, password, displayName?}` | `200 {user}` + session cookie | first-run bootstrap that creates the `owner`; returns `CONFLICT` once an **owner** exists (the guard is the owner row, not the table being non-empty) — the guarantee is the DB, not the `needsSetup` read: `users_one_owner_uidx` (§8) makes a concurrent second setup impossible |
| 4 | `POST /api/auth/register` | none, **only when `ALLOW_REGISTRATION=true` AND an owner already exists** | `registerSchema` (no `displayName`) | `201 {user}` + session cookie | public self-sign-up, creates `role='member'`; `FORBIDDEN` when the flag is false **or while no `role='owner'` row exists** — without that guard the first visitor on a fresh DB creates a `member`, which flips `needsSetup` to false and locks `/setup` out forever, leaving an install with no owner and no way to get one except editing the DB by hand (§8, PR-07); rate-limited + `auth_attempts` like login; cannot create an `owner` |
| 5 | `POST /api/auth/login` | none | `{username, password}` | `200 {user}` + `note_session` cookie | argon2id verify, timing-safe dummy hash, rate-limited |
| 6 | `POST /api/auth/logout` | yes | — | `204` | deletes session row, clears cookie |
| 7 | `POST /api/auth/logout-all` | yes | — | `204` | deletes **every** session row for the user and clears the cookie (the settings page's "sign out everywhere", §11.1); implemented in **PR-07**, consumed by **PR-16** |
| 8 | `GET /api/auth/session` | optional | — | `{user\|null, expiresAt?}` | used on boot to rehydrate UI |
| 9 | `POST /api/auth/password` | yes | `{currentPassword, newPassword}` | `204` | rotates + deletes all other sessions |
| 10 | `POST /api/users` | owner | `{username, password}` | `201 {user}` | owner-created account, always `role='member'` (only `/setup` writes `'owner'`, §8); **the only way to add an account when `ALLOW_REGISTRATION=false`**, and still available when it is true |
| 11 | `GET /api/users` | owner | — | `{users:[{id,username,role,createdAt}]}` | minimal admin surface |
| 12 | `GET /api/tree` | yes | — | `{folders:[FolderNode], notes:[NoteNode]}` | full tree metadata, **no content**; single query via recursive CTE; sized for MVP scale |
| 13 | `POST /api/folders` | yes | `{name, parentId\|null}` | `201 FolderNode` | 409 on sibling clash; 400 `VALIDATION` if the new folder would sit at depth 100 (root is depth 0 — the PR-09 create/move depth cap, §12) |
| 14 | `PATCH /api/folders/:id` | yes | `{name?, parentId?}` | `200 FolderNode` | rename and/or move; cycle guard; same depth cap as #13, but for a move the check is `depth(newParent) + 1 + height(moved subtree) ≤ 99` — a deep subtree re-parented under a shallow root is rejected too (PR-09) |
| 15 | `DELETE /api/folders/:id` | yes | query `cascade=true` | `204` | without `cascade=true` and non-empty ⇒ `CONFLICT` |
| 16 | `POST /api/notes` | yes | `{name?, folderId\|null, content?}` | `201 NoteWithContent` | `name` omitted → server generates `new-file-<msepoch>` and uniquifies it (`folderId: null` = root); `content` omitted → `seal('')`, never empty cipher/iv columns |
| 17 | `GET /api/notes/:id` | yes | — | `{…NoteNode, content, version}` | decrypts; `ETag: W/"v<version>"` |
| 18 | `PUT /api/notes/:id/content` | yes | `{content, baseVersion}` | `{…NoteNode, content, version:version+1}` | `If-Match` optional; `baseVersion` mismatch ⇒ `VERSION_CONFLICT` + current server `content` + `version` (the client compares them with its buffer before calling it a conflict — §11.4); unknown/other-user id ⇒ `404` (the write also filters `user_id`, so the service re-reads to tell the two apart — A.2) |
| 19 | `PATCH /api/notes/:id` | yes | `{name?, folderId\|null}` | `200 NoteNode` | rename / move (`folderId: null` = move to root); `notes.name` stays extension-free |
| 20 | `DELETE /api/notes/:id` | yes | — | `204` | |
| 21 | `GET /api/search?q=&limit=` | yes | — | `{results:[{noteId,name,folderPath,snippet,score}]}` | name match in SQL + body match after decrypt (cap 500 candidates) |
| 22 | `GET /api/settings` / `PATCH /api/settings` | yes | `patchSettingsSchema` | `Settings` | `autosave`, `theme`; lands in **PR-09** (not PR-16) because PR-14 needs the flag — see both PRs. The row is created with the user by **PR-07** (§8 invariant) and get-or-created by `settings.service.get()`, so neither endpoint can 404 or silently update zero rows |

Payload cap: 1 MiB note body (Fastify `bodyLimit`, → `PAYLOAD_TOO_LARGE`); UI warns at 900 KiB.

### 9.3 Concurrency & idempotency rules

- Content writes are **versioned**, not last-write-wins (see §11.4).
- `POST /api/notes` and `POST /api/folders` are idempotent-by-name inside a folder: a duplicate create returns
  `CONFLICT` including the existing id, so a double-click of "Create" in the UI ends with one note, not two.
- All mutations require the CSRF header (`X-CSRF-Token`) **except** `login`/`setup`/`register` — those have no session
  and, on a first visit, no `note_csrf` cookie either, so they are guarded by the `Origin`/`Sec-Fetch-Site` check
  instead. The `note_csrf` cookie is issued by `GET /api/auth/status` (§9.2 #2), which every page calls before it can
  render a form, and `lib/api.ts` echoes that value back in the header on every subsequent mutation.


---

## 10. Security model (incl. encryption at rest)

Implemented across PR-06, PR-07, PR-09, PR-18. Threat model = a single-instance self-hosted app exposed on a
home/LAN/VM network, possibly behind a reverse proxy.

**Transport & cookies**

- `note_session` cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when behind TLS (`SECURE_COOKIES=true`),
  `Path=/`, `Max-Age = SESSION_TTL_DAYS` (default 30). Rotation on login and on password change.
- Session token: 32 random bytes, base64url; DB stores `sha256(token)` only ⇒ a DB dump cannot authenticate.
- CSRF: non-`GET` `/api/*` requests require `X-CSRF-Token` matching a non-HttpOnly `note_csrf` cookie
  (double-submit) + `Origin`/`Sec-Fetch-Site` check. SPA reads the CSRF cookie on boot (`lib/api.ts`).
  **Lifetime, rotation and re-issue (the rules the first draft omitted — a cookie with no expiry and one issuer strands a
  tab that outlives its token):** `note_csrf` is `SameSite=Lax`, `Path=/`, non-`HttpOnly`, `Max-Age = 1 day` (shorter
  than the session), value = 32 random bytes base64url, and it is (re-)issued by `GET /api/auth/status` **and** by every
  `setup`/`login`/`register`/`logout` response, so it is never older than the browser session carrying it. It stays
  unbound to a specific `sessions` row by design — the double-submit equality plus the `Origin`/`Sec-Fetch-Site` check is
  what does the binding in a single-instance MVP, and adding a `sessions.csrf` column is backlog. On a `403 FORBIDDEN`
  from any mutation, `lib/api.ts` re-fetches `/api/auth/status` **once** and replays the mutation **once** before
  surfacing the error, so a long-open tab recovers instead of failing forever. Ownership splits along the file, not the
  idea: **PR-05** implements this client rule inside `apps/web/src/lib/api.ts`, the file it owns (§7), unit-testing it
  against a mocked `fetch`; **PR-07** owns the server half (the `403` itself and the `note_csrf` re-issue on
  `/api/auth/status`), and its acceptance is where the two halves are proven together.
- Security headers via `@fastify/helmet`: `CSP` for the SPA (no `unsafe-eval`; inline styles only via nonce if
  needed), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Markdown preview is **sanitized** (`rehype-sanitize`): no raw HTML, no `javascript:` URLs, `rel="noopener"`.

**Passwords & brute force**

- argon2id via `@node-rs/argon2` with OWASP-ish parameters (`memoryCost 65536, timeCost 3, parallelism 1`),
  per-password random salt, encoded string stored in `password_hash`.
- Password policy: ≥ 10 chars, no username equality, ≤ 512 bytes (argon2 pre-hash guard).
- Login rate limit: in-process sliding window (10 attempts / 15 min per `lower(username)`+IP) **plus** durable rows
  in `auth_attempts` for audit; the slot is taken as the request arrives rather than when it fails, so the 11th
  attempt is refused even with the right password. On trip → `429 RATE_LIMITED` with `Retry-After`.
- Unknown user runs a dummy `argon2.verify` to keep timing uniform.

**Tenancy / injection**

- No raw SQL string interpolation: Drizzle query builder + parameterized SQL only; the recursive CTE uses bind
  params for `user_id`/`folder_id`.
- `user_id` scoping is applied inside repositories, not routes, so a forgotten filter is structurally hard.
- File-name handling: names are data, never paths — nothing is ever written to a container FS path, so path
  traversal is not reachable. Zod still rejects `/ \ NUL control chars leading/trailing space reserved names`
  and clamps length to 120 to keep the UI and index sane.

**Encryption at rest (Q1)**

- AES-256-GCM, 256-bit master key from `NOTE_ENCRYPTION_KEY` (base64), AAD = `note:<uuid>` so ciphertexts are not
  portable between rows; fresh 12-byte IV per write; `key_version` per row.
- Keyring supports one *current* key plus N *previous* keys (`NOTE_ENCRYPTION_KEY_PREVIOUS`, JSON map
  `{"1": "<base64>"}`) so the operator script `apps/server/src/scripts/rotate-note-key.ts` (compiled into
  `apps/server/dist/scripts/`, run inside the production image — §15) can read old rows and rewrite them with the new key. The current
  key's version is **its own variable — `NOTE_ENCRYPTION_KEY_VERSION` (integer, default `1`)** — never derived from the
  `_PREVIOUS` map (deriving it as `max(previous)+1` collapses back to 1 the moment the map is emptied, silently
  orphaning rows tagged 2). Rotation therefore: set the new key + bump the version, move the old key into `_PREVIOUS`,
  then rewrite every row (new ciphertext **and** new `key_version`); a row keeps decrypting through `_PREVIOUS` until no
  row references that version anymore.
- What is **not** encrypted: usernames, folder/note names, timestamps, sizes — required for tree queries and
  listings without mass decryption. Documented as an accepted MVP limitation in ADR-0002.
- Data-loss caveat recorded in `docs/DEPLOY.md`: **losing `NOTE_ENCRYPTION_KEY` makes note bodies unrecoverable**;
  the key file must be backed up with the DB. `crypto/keys.ts` logs a key fingerprint (first 8 hex of sha256) at
  startup so operators can verify which key a database was written with.

**Container hardening (PR-18)**

- Multi-stage build; final image `node:22-slim`, non-root `USER node`, `pnpm deploy --prod` (or `npm ci --omit=dev`)
  pruned install, no build toolchain in the runtime layer. `node:22-slim` ships **no `curl`**, so the healthcheck must
  not use it: `HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`
  (Node's global `fetch`, no extra package; `init` via `docker compose` `init: true`).
- App image contains no secrets; `DATABASE_URL`/`NOTE_ENCRYPTION_KEY` come from env/compose.
- The compiled `env.ts` bootstrap (`index.ts`, PR-01 + PR-06) fails in **every** environment when `NODE_ENV` is unset
  or not one of `development | test | production` — there is **no default**, so a container that forgot to set it cannot
  silently boot in the least-restrictive mode. In `production` it additionally refuses to start when:
  `DATABASE_URL` **unset in the process** (the `POSTGRES_*` derivation is a `development`/`test` convenience only,
  §16; inside the stack Compose hands the app a composed DSN, so this guard is armed and satisfied there — §15),
  `NOTE_ENCRYPTION_KEY` missing/≠32 bytes **and** `NOTE_ENCRYPTION_KEY_FILE` unset/unreadable,
  `SESSION_TTL_DAYS` > 365, `SECURE_COOKIES=false` while `TRUST_PROXY=true`, or
  `ALLOW_REGISTRATION=true` while `SECURE_COOKIES=false` (public sign-up over plain HTTP). The first account is
  **always** created through `POST /api/auth/setup`; there are no `INITIAL_*` environment credentials.
  `scripts/check-env.ts` (PR-18) applies the same rules as a dev/CI preflight with operator-facing error text, with
  **one deliberate difference on the DSN**: the boot guard judges the **process**, where Compose has already composed
  the DSN, while the preflight judges the **file**, where it has not. So the preflight is satisfied by either a literal
  `DATABASE_URL` or the complete `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` trio — exactly the inputs
  `compose.yml` composes into the app service's DSN (§15) — and warns when both forms are present and disagree. A file
  with neither is the failure it reports. Without that carve-out the documented prod `.env` (trio, no DSN) could never
  pass its own preflight. Neither path requires `pnpm`/`tsx` inside the runtime image — the container only runs
  compiled JS (PR-18).

- **There is no plaintext mode** (this replaces the earlier "plaintext in development" idea, which the schema cannot
  represent — `content_cipher`/`content_iv` are NOT NULL and nothing marks a row as plain). In `development`/`test`,
  when no key is configured, `crypto/keys.ts` generates one on first boot, **persists** it to `.dev/note-key`
  (gitignored, mode `0600`, directory created with `mkdir -p`), logs the path plus the fingerprint, and reuses it on
  later boots — so dev rows survive restarts while production still fails hard. §21 item 5 records the decision.

---

## 11. Frontend architecture (routes, state, autosave, editor)

### 11.1 Routes (TanStack Router, file-based)

| Path | Guard | Purpose |
| --- | --- | --- |
| `/setup` | only when `needsSetup` | create the first account (README: self-hosted, first-run) |
| `/login` | redirect away when authed | username + password, error + rate-limit messaging |
| `/signup` | only when `registrationOpen` **AND** `!needsSetup`; otherwise redirect to `/login` (`/setup` on a fresh install) | self-sign-up form; creates a `member` (route + guard land in PR-08, server guard in PR-07) |
| `/welcome` | — | **does not exist: PR-12 deleted `routes/welcome.tsx`.** PR-08's placeholder home; a bookmark to it is an unknown path and lands on `/app` when signed in |
| `/app` | auth | AppShell; default view = recent notes + "New note" |
| `/app/note/$noteId` | auth | editor + preview for one note |
| `/app/search` | auth | search results (`?q=`) |
| `/app/settings` | auth | autosave toggle, theme, change password, sign out all sessions |
| `*` | — | redirect: authed → `/app` (`/welcome` until PR-12 creates it), else → `/login` or `/setup` |

Route guards live in `routes/app/route.tsx` (`beforeLoad` reads the session context) — never per-page. **That file name is
TanStack Router's own convention:** in file-based routing a directory's layout route is `route.tsx` inside it
(`routes/app/route.tsx` wraps `index.tsx`, `note.$noteId.tsx`, `settings.tsx`, `search.tsx`); `__layout.tsx` is the
Next.js App Router habit and is not what the router's plug-in picks up. Until PR-12
created that layout, the authed redirect target was `/welcome` (created in PR-08, deleted by PR-12), which kept
PR-08's acceptance testable on its own. PR-12 repointed every authed landing and redirect at `/app`, and the guard
matches `/app` as a **prefix** (`isAppPath` in `session.tsx`), so a later PR adds `/app/search` or `/app/settings`
without teaching the guard anything.

### 11.2 State

| Kind | Where |
| --- | --- |
| Server state (tree, note content, settings, session) | TanStack Query, cache keys `['tree',userId]`, `['note',id]`, `['settings']` |
| Mutations | TanStack Query mutations with optimistic tree updates + rollback on error (a **create** has no id to insert optimistically — `POST /api/notes` mints it, so the row enters the tree on confirmation; PR-15 §9) |
| Editor buffer (uncommitted text) | **the autosave engine owns it** (PR-14): `lib/autosave.ts` holds the buffer and the editor renders `snapshot().buffer`, because §11.4's conflict comparison needs one owner of the string that went on the wire and a component holding its own `useState` on top of the engine is two. Mirrored to `localStorage['note-draft:<id>']` so a browser crash keeps the last buffer |
| Transient UI (dialogs, preview mode, sidebar width) | local state + a tiny `ui` store for sidebar/preview mode persisted in `localStorage` |

No global client store (no Redux/Zustand) in the MVP — Query + Router cover it, and less state means fewer bugs.

### 11.3 Editor (Q3)

- `MarkdownEditor`: CodeMirror 6 with the Markdown language extension, soft wrap, `Cmd/Ctrl+B/I/K` shortcuts — the
  keymap is **scoped to the editor**, so while it has focus `Cmd/Ctrl+K` inserts a link there and the shell's global
  search-link chord (§11.5) does not fire — line numbers off, `aria-label="note content"`.
- `EditorToolbar` buttons: H1/H2/H3, bold, italic, strikethrough, inline code, code block, blockquote, bullet list,
  numbered list, task list, link, table, horizontal rule. Each button is a **pure transform** in
  `lib/markdown.ts`: `(selection, text) => {text, selection}` — unit-tested without a DOM, and applied to the CodeMirror
  transaction so undo history stays native.
- `PreviewPane`: `react-markdown` + `remark-gfm` + `rehype-sanitize`; scroll-synced (best effort) in split mode.
- Modes: `split | write | preview` (button group, persisted). Default `split` on ≥ 1024 px, `write` below.
- Frontmatter is treated as ordinary text in the MVP (preserved, not parsed).

### 11.4 Autosave engine (`lib/autosave.ts`, PR-14)

Explicit state machine, unit-tested with fake timers:

```
clean ──edit──▶ dirty ──debounce 1200ms──▶ saving ──200──▶ clean
                                   └──5xx/transport──▶ retry(backoff 1s,2s,4s,8s,30s) ──▶ saving
saving ──VERSION_CONFLICT──▶ (payload == the snapshot we sent ? clean | dirty : conflict)
                                     conflict ──(user picks)──▶ overwrite | loadServer
```

**The `VERSION_CONFLICT` fork is what makes a retry safe, and it is not optional.** A `PUT` that the server committed
but whose response never arrived (connection reset, proxy `502`/`504`, client timeout) is indistinguishable, from the
client's seat, from a `PUT` that never reached the server. So the retry replays with the old `baseVersion`, the
conditional `UPDATE` in A.2 matches 0 rows, and a client that treats every conflict as a collision shows
`ConflictBanner` and pauses autosave on a note whose server content **already equals the buffer** — a phantom
conflict the user cannot resolve except by clicking through their own text. **That is why the engine keeps the exact
payload it put on the wire** — the in-flight snapshot, not a reference to the live buffer, which A.5 lets a later keystroke
change. Rule: on `VERSION_CONFLICT`, compare the `content` the error payload carries (§9.2 #18) with that snapshot.
Equal ⇒ the write landed, only the reply was lost ⇒ adopt the payload's `version` and continue with no banner and no
pause: to `clean` if the live buffer still equals the snapshot, to `dirty` if the user typed meanwhile (the next debounce
then writes the newer buffer against the adopted `version`). Different ⇒ a real second writer ⇒ `conflict`.
Comparison is on the plaintext buffer before sealing, not on ciphertext: the seal is randomized
(`crypto/envelope.ts`, §10), so two seals of one string never compare byte-equal. A per-request idempotency key was
considered and rejected for the MVP: it needs a dedupe table plus an expiry policy and still has to answer "same
request or new edit?" the moment the user types during the retry, which is the same question the content comparison
answers for free. Recorded in `docs/ARCHITECTURE.md` (PR-20) next to the A.2 write path.

- Flush triggers: debounce (default 1200 ms), `maxUnflushedMs = 10 000`, `Ctrl/Cmd+S`, note switch, folder
  rename/move affecting the open note, `window blur`, and `visibilitychange → hidden` / `pagehide` via
  `fetch(…, { keepalive: true })` with the normal `PUT` + `X-CSRF-Token` headers.
  **No `navigator.sendBeacon`:** it can only `POST` and cannot set headers, so it cannot carry
  `PUT /api/notes/:id/content` with the CSRF header (§9.3). `keepalive` requests are also capped at ~64 KiB of
  body by the browser, while notes may reach 1 MiB (§9.2), so the unload path is deliberately bounded:
  - dirty buffer ≤ 60 KiB (safety margin): best-effort `fetch(keepalive:true)` on `pagehide`;
  - dirty buffer > 60 KiB: **no unload write is attempted**; the ≤ 10 s force-flush plus the explicit
    dirty-guard prompt ("Save / Discard / Stay", §11.4 autosave-off bullet) are what protect the data, and the
    `localStorage` draft mirror (§11.2) is the crash fallback. The pill shows `Unsaved changes` so the user
    is never told "Saved" for a buffer that could not be flushed.
  A CSRF-exempt beacon endpoint was rejected: it would trade a small convenience for a new write path that the
  CSRF model does not cover (recorded in `docs/ARCHITECTURE.md`).
- Every write sends `baseVersion = lastKnownServerVersion`. On `VERSION_CONFLICT` the server returns its current
  content; the UI shows `ConflictBanner` with *Keep mine* / *Use server* / *Copy server text*, never silently overwrites.
- `SaveStatus` pill in `StatusBar`: `Saved 12:03:11`, `Saving…`, `Unsaved changes`, `Retrying (2)…`, `Conflict`,
  `Autosave off — Ctrl+S to save`.
- When `settings.autosave === false`: no debounce writes; `Ctrl/Cmd+S` and the explicit Save button still work;
  navigating away with a dirty buffer prompts ("Save / Discard / Stay").
- Autosave is disabled while the engine is in its **`conflict`** state (the autosave state machine's own state name,
  entered when the API answers `VERSION_CONFLICT`). Note the vocabulary: `VERSION_CONFLICT` is the API error code for a
  stale `baseVersion`, plain `CONFLICT` is the generic code for a sibling-name clash (§9.1) — the autosave machine never
  reacts to the latter.

**Seven things only writing the code settles, recorded because PR-16/19 read this section as behaviour (PR-14):**

- **Nothing leaves while a reply is owed.** A request that went out and never came back is an answer the client has
  not read. So every flush that arrives during a backoff — the debounce, the 10 s cap, `blur`,
  `visibilitychange → hidden`, a note switch, an unmount, `Ctrl/Cmd+S` — sends **the request that failed**, its bytes
  and its `baseVersion` unchanged, and never a fresh capture of the buffer: newer text written against the version we
  left on the wire is answered by a `VERSION_CONFLICT` carrying *our own* earlier write, which the fork would then
  read as a second writer. Such a flush moves the replay earlier and leaves the spent retry budget spent; keystrokes
  typed meanwhile go out in the window after it settles, which is the "to `dirty` if the user typed meanwhile" case
  above rather than a second interpretation of it. The 10 s cap opens no second window beside a scheduled replay, and
  no 10 s deadline is armed next to a 30 s backoff, because "the backoff is exactly 1 s, 2 s, 4 s, 8 s, 30 s" is a
  promise this section makes.
- **A person re-funds the retry schedule; a trigger does not, and neither keeps the old failure.** A flush during a
  backoff buys nothing, but `Ctrl/Cmd+S` and *Retry* arriving from the spent-budget `error` state are §4's own "manual
  retry" row, so they clear `attempt` and the message before the replay — without that, the spent `attempt` made the
  next failure terminal instead of opening a fresh 1 s window, and the pill read `failure` before it read the state
  (`saveStatusText`'s precedence), so it said "Not saved — …" with `data-state="error"` over a request that was on its
  way out. A `blur`, a note switch or a `hidden` that lands in the same state sends the owed request and clears the
  message, because a pill must never describe a failed cycle while a request is in flight, but it does not buy a new
  schedule: §4 makes the next cycle the user's decision.
- **An explicit resolution supersedes the owed replay.** *Keep mine*, *Use server* and a re-read of the note each say
  what the row holds and at which version, which is the only question a replay exists to ask, so each drops it. The
  unload `keepalive` write is the one place that sends newer text while a reply is owed: only one request can leave an
  exiting page, and losing the buffer would be the worse loss. On the next load the row and the draft mirror disagree,
  which is what the restore prompt is for.
- **The snapshot is the screen's only window.** `snapshot()` is cached and `notify()` is the only thing that clears the
  cache, and the editor renders `snapshot().buffer` — so a path that updates the buffer without publishing makes a
  controlled editor swallow the keystroke that woke it, in `conflict` and in the two stopped rows being exactly the
  states where the text has to stay visible. `onEdit` publishes on every path, and `dirty` means "newer than the row"
  everywhere: undoing back to the saved text is `clean`, not a pill reading "Unsaved changes" over a write that will
  never start.
- **The unload guard is the negation of "the unload carries this", not of the budget alone.** `beforeunload` is armed
  only when the buffer is dirty *and* nothing is carrying it: clean, or a `keepalive` request already leaving with
  exactly that text, or `pagehide` still able to start one — those need no prompt. An **ordinary** in-flight `PUT`
  never counts as carried, because the unload aborts it, and an autosave-off or over-budget buffer is never carried
  either. A prompt over a save already leaving is noise; a missing prompt over a buffer that cannot leave is data loss.
- **`visibilitychange → hidden` goes out on the unload transport — but only when nothing is owed — and the budget
  measures the body.** A closing tab hides *before* `pagehide` (the unload steps are hide → `beforeunload` →
  `pagehide`), so the ordinary `PUT` a `hidden` handler used to start occupied rule 1, was aborted by the unload, and
  left `pagehide` with nothing it may start — the `keepalive` path never ran on a normal close. Within the budget
  `hidden` now sends `fetch(…, {keepalive: true})`, and a mere tab switch is unharmed, because a live page reads a
  `keepalive` reply normally. **The first bullet outranks that transport:** with a replay owed, `hidden` behaves like
  every other trigger and sends the owed request, because the ordinary `hidden` is a tab switch whose page survives,
  and a keepalive write of the newest buffer against the abandoned `baseVersion` is answered by a `VERSION_CONFLICT`
  carrying *our own* lost write — a conflict fork about the reader's own edit, on a page that is still open and could
  have retried. `pagehide` alone keeps the right to supersede the owed request (the bullet above). That ~64 KiB cap is
  a cap on the **request body**, which `lib/api.ts` builds with `JSON.stringify({content, baseVersion})`, and escaping
  is not
  free: a `"` or a `\n` costs two bytes and a control character six, so 58 KiB of quotes is a ~116 KiB body that
  `fetch` rejects before it leaves — *after* the predicate had promised the buffer fitted. `contentWriteBytes` is that
  measure, and the two-key body it assumes is pinned by `note.mutations.test.ts`.
- **The draft mirror clears only on a match.** `localStorage` is per-browser and the key is per-note, so a write
  confirmed in one tab must not delete another tab's unsaved text: `clear(text)` removes the key when it still holds
  exactly `text` and leaves it alone otherwise. The mirror is not an `nt.` `uiStore` preference and does not go through
  that store; it is a note body under a key §11.2 names.

### 11.5 UX details that the README implies and must not be skipped

- **New note dialog**: name input pre-filled with `new-file-<Date.now()>.md`, the `.md` rendered as a fixed suffix
  (input value excludes it; suffix is a sibling element so it cannot be edited or deleted), target folder defaults
  to the selected folder/root, "Create" is disabled while the name is invalid or collides (debounced
  uniqueness check against the tree cache, no extra endpoint).
- Rename dialogs reuse the same component with the current name and the same fixed `.md` suffix for notes.

**Three things PR-15 only settled in code, recorded because PR-12/13/19 read this section as behaviour:**

- **The suffix is a sibling element, not a character.** The input's value is the editable name; `.md` is a node after
  it. A `keydown` guard for "cannot be deleted" has to enumerate every way a character leaves a field (backspace,
  delete, cut, drag-out, drop, autofill, IME and screen-reader replacements); the markup rule has no cases. The one
  route that still gets `.md` into the value is a paste, and `stripMd` removes it from the request body.
- **The uniqueness check is a debounced read of `['tree', userId]`, never a request.** The tree already lists every
  sibling, so a "is this free?" endpoint re-learns a list this tab is holding. The consequence is deliberate: a tab
  that has not fetched the tree has no opinion, so the `409 CONFLICT` (with the winner's id) is a first-class branch
  of the dialog, not an error page.
- **Creating hands the caret over through the cache, not the URL.** `['editor-focus']` holds the id this tab just
  created; PR-13's editor page asks `takesEditorFocus(client, id)` on mount. A `?focus=1` would be bookmarked and
  re-opened, and a one-shot consume would be eaten by `StrictMode`'s double mount (PR-15 §9).
- Everything reachable by keyboard: tree arrow-key navigation, `Enter` to open, `F2` rename, `Delete` delete,
  `Ctrl/Cmd+K` (search *page* link in MVP, palette is backlog). Two chord rules keep this collision-free:
  **`Ctrl/Cmd+K` is editor-scoped against shell-scoped** — while the CodeMirror editor has focus, its keymap owns the
  chord and inserts a link (§11.3), and the shell's global handler (PR-17) checks whether the editor is focused before
  acting, so the search-link focus never fires mid-edit and link insertion never leaves the editor;
  **`Ctrl/Cmd+N` is deliberately *not* bound** — Chromium opens a new window/tab before any page handler sees the key
  (Firefox/Edge reserve it likewise), so the app cannot reliably intercept it; new-note stays keyboard-reachable
  through its `TopBar`/tree-context-menu buttons (PR-15), and a chord for it belongs with the palette backlog (§3.2).
- Destructive actions (folder with children, note delete) require typing the item name.
- Toasts on every failed mutation with the server `error.message`.


---

## 12. Work breakdown — pull requests

Total MVP estimate: **~26–42 engineer-days** serial — the sum of the §1 size bands over the 20 PRs below
(4 × `S` ≤ ½ day = ~2, 12 × `M` = 1–2 days = 12–24, 4 × `L` = 3–4 days = 12–16); **~3–4 weeks calendar** with 2 engineers
using the parallel tracks in [§13](#13-dependency-graph--parallel-execution-tracks).

Global PR rules (apply to every task below, not repeated): conventional-commit titles
(`feat:`, `fix:`, `chore:`, `test:`, `docs:`); PR body starts with `Task: PR-NN`; CI must be green; every PR
that changes behavior also updates the affected doc (`README.md`, `docs/API.md`, `docs/DATA-MODEL.md`, ADRs);
no PR may lower a coverage threshold; every new DB column ships with a generated migration in the same PR.

### PR index

| ID | Title | Size | Depends on | Track |
| --- | --- | --- | --- | --- |
| PR-01 | Monorepo scaffold, tooling, hello-world app | M | — | A Foundation |
| PR-02 | Dev infra: Postgres in Docker, Makefile | S | 01 | A |
| PR-03 | Real CI (replaces placeholder `CI.yml`) | M | 01 | A |
| PR-04 | DB schema, migrations, repository harness | L | 01, 02 | B Data |
| PR-05 | Shared contracts (Zod DTOs, error envelope, typed client) | M | 01 | B |
| PR-06 | Envelope encryption + key mgmt + rotation | M | 04, 05 | B |
| PR-07 | Auth core (users, sessions, cookies, CSRF, rate limit) | M | 04, 05 | C Auth |
| PR-08 | Auth UI (setup/login/sign-up, session context, UI kit) | M | 05, 07 | C |
| PR-09 | Folders & notes CRUD API + tree + settings API + seed script | L | 05, 06, 07 | D Domain |
| PR-10 | Note content read/write + versioning | M | 06, 09 | D |
| PR-11 | Search API | M | 10 | D |
| PR-12 | App shell + folder tree UI | L | 08, 09 | E UI |
| PR-13 | Markdown editor + toolbar + preview | L | 12, 10 | E |
| PR-14 | Autosave engine + conflict UX | M | 10, 13, 09 | E |
| PR-15 | New-note dialog (`new-file-<ms>.md`) | S | 12, 09, 13 | E |
| PR-16 | Settings **UI** (autosave toggle, theme, password form) | M | 07, 09, 14 | E |
| PR-17 | Search UI | S | 11, 12, 13 | E |
| PR-18 | Production Docker image + compose + deploy docs | M | 01–17 | F Ship |
| PR-19 | Playwright e2e + CI e2e job + coverage ratchet | M | 08–18 | F |
| PR-20 | Docs pass (README, ADRs, ARCHITECTURE, AGENTS.md) | S | 18, 19 | F |

---

#### PR-01 — Monorepo scaffold, tooling, runnable hello-world app
**Branch:** `feat/pr-01-scaffold` · **Size:** M · **Depends on:** —

- **Goal:** a cloneable repo where `pnpm i && pnpm dev` serves a page and `pnpm build` produces a deployable
  artifact; all quality gates exist from day one so later PRs can only *add* tests, never bolt on tooling.
- **Create:** `package.json` (root, `packageManager`, workspace scripts: `dev build build:packages lint format typecheck test
  test:integration coverage` — `build:packages` (`pnpm -r --filter './packages/**' build`) is defined here even though
  `packages/` only appears in PR-05, so PR-03's CI steps can call it from day one; while nothing matches the filter it is a
  no-op, and §14 explains why every typecheck/test job needs it. `coverage:integration` is registered later, by PR-04,
  together with the integration config
  it needs (§14), and `test:e2e` later still, by **PR-19**, together with the Playwright config it runs — §17's e2e row
  names that command, and no script may be invoked before the PR that creates the files it runs owns it
  (§14's job rule, applied to scripts) — **and the dev scripts must carry `NODE_ENV` themselves**: `dev` is
  `pnpm build:packages && pnpm -r --parallel --filter './apps/**' dev` (pnpm's own parallel runner, no extra dependency; the
  leading build is a no-op until PR-05 creates `packages/`, after which it is what lets `tsx`/`vite` resolve
  `@note-taker/contracts` at all — §14), each app's `dev` is its own script, and `apps/server`'s is
  `NODE_ENV=development tsx watch src/index.ts` (POSIX; the Windows-safe variant
  `cross-env NODE_ENV=development …` if the owner develops on Windows — §21; the rule covers every host script that
  touches env, listed below). `.env.example` ships `NODE_ENV=development` — that line is for Compose interpolation and
  for the human editing the file; **no Node process takes its mode from it** (§16) — and the README quick start says
  `cp .env.example .env`, but PR-01 must boot **without** any
  `.env`, because the Makefile that copies it only arrives in PR-02 and `env.ts` (created here) rejects an unset
  `NODE_ENV` in every environment (§10, §16). **Loading `.env` for host processes is a PR-01 artifact too:** `env.ts`
  exports `loadDevEnvFile()` **and** `databaseUrl()` — the single DSN resolver (§16: a set `DATABASE_URL` is used
  verbatim; otherwise it is composed from `POSTGRES_*` in `development`/`test`; production has no default), which
  `index.ts`, `db/client.ts` and `db/migrate.ts` all go through, and PR-04/PR-09 reuse both from
  `drizzle.config.ts`, the integration Vitest setup and `scripts/seed-demo.ts` (§16's "How the repo-root `.env` reaches
  a process"). Compose's `--env-file` feeds Compose's interpolation only, so without that function `pnpm dev` here,
  `pnpm db:migrate`/`drizzle-kit` and `pnpm test:integration` in PR-04, and `db:seed` in PR-09 would each silently
  ignore the very file the README tells the reader to create. A function, not a repeated flag: plain `node --env-file`
  hard-fails when the file is missing (verified on 22.22 — exit 9), which contradicts this PR's own bare-clone
  acceptance, and the softer `--env-file-if-exists=../../.env` would need a different relative path per entry point
  (`tsx` runs from `apps/server/`, drizzle-kit and Vitest read their own configs, the image runs `dist/…`) and would
  still have to be added to `db:migrate`, `db:seed` and `test:integration` separately (§16). The DB scripts are
  **not** stubbed here: `db:generate`/`db:migrate` arrive with PR-04 and `db:seed` with PR-09, when the runner/script
  behind them exists. **Every one of those scripts declares its mode inline, exactly as `dev` does** — a PR-01 contract
  the later PRs implement, because `loadDevEnvFile()` and `databaseUrl()` gate on the *process* `NODE_ENV` (§16) and a
  `.env` line can never supply it: `db:generate`/`db:migrate` are `NODE_ENV=development drizzle-kit …` (PR-04),
  `db:seed` is `NODE_ENV=development tsx scripts/seed-demo.ts` (PR-09), `test:integration`/`coverage:integration` are
  `NODE_ENV=test vitest run --config …` (PR-04), and `check:env` is `NODE_ENV=production tsx scripts/check-env.ts`
  (PR-18). POSIX form, with the `cross-env` variant under §21 item 10. A script that forgets the assignment dies on
  §10's missing-`NODE_ENV` message rather than silently choosing a mode — which is the whole point of the gate, so no
  script may paper over it with a default. `pnpm-workspace.yaml`, `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `biome.json`,
  `.editorconfig`, `.gitignore`, `.dockerignore`, `.nvmrc`, `LICENSE` (MIT — confirm in §21), `.env.example`,
  `apps/server/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/{index.ts,app.ts,env.ts,logger.ts,routes/health.routes.ts}}`,
  `apps/web/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,index.html,src/{main.tsx,routes/__root.tsx,styles/globals.css}}`,
  minimal `apps/web/src/routes/index.tsx` placeholder that renders a "coming soon" card. `apps/server` ships **two
  TypeScript programs**: `tsconfig.json` is the one `pnpm typecheck` runs and it keeps the `*.test.ts` files, while
  `tsconfig.build.json` is the one `pnpm build` compiles and excludes them — `tsc` has no CLI `--exclude`, and `dist` is
  a shipped artifact (PR-18 copies it into the image), so it must not contain the suite that tests it.
  **Both Vitest configs scope the
  unit run explicitly** — `include: ['src/**/*.test.{ts,tsx}']` plus `exclude: ['**/*.int.test.ts']` — because Vitest's default
  include is `**/*.{test,spec}.*`, which would otherwise pull the DB-backed files PR-04 adds into `pnpm test` and into the
  Postgres-free `unit` job (§14's split rule); stating it here, before any such file exists, is what keeps PR-04 from
  having to edit PR-01's config. The **web** config also sets `passWithNoTests: true`, because PR-01 deliberately ships
  no web tests and Vitest otherwise exits 1 with "No test files found" — which would break this PR's own `pnpm test`
  acceptance and PR-03's `unit` job. It is set on the web config only: the server has `env.test.ts`/`app.test.ts` from
  day one, and an empty server suite should be red. The web config also carries **no `coverage.thresholds`**, because a
  threshold over a scope with nothing in it is a guaranteed red: the `apps/web/src/lib` row of §14 is armed by **PR-05**
  (whose mocked-`fetch` tests for `lib/api.ts` are the first web tests) and the overall `apps/web/src` row by **PR-08**
  (the first components).
  **`AGENTS.md` is updated here, not deferred:** the file lists **no commands today**, so this PR **adds** the real
  ones it introduces (`pnpm i / dev / build / lint / typecheck / test`) — the file's first-ever command list —
  because §1's same-PR doc rule — inherited from
  `AGENTS.md` itself — forbids leaving it stale while PR-20 waits at the end. PR-20 then *consolidates* the accumulated
  edits; it is not the first PR allowed to touch the file.
- **Acceptance:** **from a bare clone with no `.env` file present**, `pnpm i && pnpm dev` boots and
  `GET /api/health` returns `{status:'ok'}` — i.e. the dev path supplies `NODE_ENV=development` on its own. The guard is
  proven **without** going through the dev script (whose inline `NODE_ENV=development` assignment would defeat any
  `env -u NODE_ENV` attempt, so that command is deliberately *not* the test): (a) `env.test.ts` asserts that parsing an
  env with `NODE_ENV` absent fails with the readable missing-var message, in every branch (`development`, `test`,
  `production`, unset); (b) after `pnpm build`, `env -u NODE_ENV node apps/server/dist/index.js` exits non-zero before
  `listen()` — the compiled entry, so nothing in the chain re-supplies the value.
  `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm build` all exit 0; `vite` proxies `/api` to `:3000` (the target is a plain constant in
  `vite.config.ts`, overridable with `VITE_API_TARGET` on a machine where `:3000` is already taken); server built with
  `tsc` (no bundler) to `apps/server/dist`,
  web built to `apps/web/dist`; `env.ts` rejects unknown/missing required vars and is unit-tested; **no `db:*` script is registered yet** (`pnpm db:migrate` fails as an unknown script until PR-04 adds it, and nothing in CI calls it before then).
- **Tests:** `env.test.ts` — prod invariants; the `.env` loader via `DOTENV_PATH` pointing at a temp fixture (file values appear when the process env lacks them, a value already in the process env wins, a missing file is a silent no-op, an unreadable file throws (only `ENOENT` is tolerated — Node 22's parser tolerates malformed *content*, so the loud fixture is a directory), and with `NODE_ENV=production` the file is never opened at all); and `databaseUrl()` as a pure function with no DB involved (a set `DATABASE_URL` comes back verbatim; with it unset the DSN is composed from `POSTGRES_*`, so changing `POSTGRES_PORT` changes the string every host tool will use; with `NODE_ENV=production` and no `DATABASE_URL` it fails as a missing required var; a `POSTGRES_PASSWORD` containing a reserved URL character (`@ : / + % ? #`) fails with a readable error naming the variable instead of returning a mangled composed DSN) — all §16. Plus `app.test.ts` (`app.inject('/api/health')` = 200).
- **Out of scope:** any DB code, any real UI.

#### PR-02 — Local dev infrastructure (Postgres in Docker, Make)
**Branch:** `chore/pr-02-dev-infra` · **Size:** S · **Depends on:** PR-01

- **Create:** `docker/compose.dev.yml` (`postgres:16-alpine`, named volume, `POSTGRES_*` from `.env`, healthcheck,
  host port 5432), `Makefile` (`make db-up db-down db-reset dev build test coverage` — no `db:seed` target yet, that
  arrives with PR-09 once there is a schema and an auth service to hash the demo password with).
  Every `make` target pins the full invocation — `docker compose --env-file .env -f docker/compose.dev.yml …` —
  because Compose auto-loads `.env` from the compose file's own directory (`docker/`), not the repo root; PR-18
  follows the same rule for `docker/compose.yml`, so there is one convention to remember (see §15).
  **`.env` is bootstrapped, never assumed:** a `bootstrap-env` helper target runs
  `test -f .env || cp .env.example .env`, and every target that passes `--env-file .env` (`db-up`, `db-down`, `db-reset`,
  `dev`) depends on it — Compose hard-errors when the `--env-file` path is missing, so a cold clone would otherwise fail
  before Docker is even contacted. PR-02 also **extends `.env.example`** (PR-01 ships it with `NODE_ENV` only) with the
  dev-only `POSTGRES_*` and `HOST_PORT` defaults the dev compose file interpolates, so the copy produces a working
  file rather than a stub — and deliberately **no** `DATABASE_URL` line, so host commands derive the DSN from the
  same `POSTGRES_*` values and one edit moves the dev container and the host tools together (§16's DSN bullet,
  asserted in PR-04).
- **Acceptance:** from a cold clone (`pnpm i` only — **no `.env`, no schema**): `make db-up` creates `.env` from
  `.env.example` and leaves a healthy Postgres (`pg_isready -h localhost -p 5432` exits 0), `make db-reset` recreates it,
  and `make dev` serves the hello-world
  app + `GET /api/health` = `ok`. A README "Local development" section documents those commands; no committed
  credentials (dev defaults only); changing `POSTGRES_PORT` in the repo-root `.env` actually changes the host port
  after `make db-up` (proves the env file is really being read **by Compose** — the other half, the host process reading
  the same file through PR-01's `loadDevEnvFile()`, is asserted in PR-04, where the first DB-backed command exists).

- **Explicitly not asserted here:** `pnpm db:migrate` / `pnpm db:seed` — they cannot pass before PR-04 (schema,
  drizzle config, migration runner) and PR-09 (demo user + tree). PR-04 owns the first green `db:migrate`, PR-09 owns
  `scripts/seed-demo.ts` + `pnpm db:seed`.
- **Tests:** nothing to unit-test (compose + make only); the `pg_isready`/`/api/health` checks above are the proof.
- **Out of scope:** production image (PR-18), CI (PR-03), migrations (PR-04), seed data (PR-09).

#### PR-03 — Real CI (replaces the placeholder workflow)
**Branch:** `ci/pr-03-real-ci` · **Size:** M · **Depends on:** PR-01 (lands before PR-04 if possible; PR-04 can
merge with the placeholder still in place — see "Jobs added later" below)

- **Modify:** `.github/workflows/CI.yml` — **delete the `placeholder` job but keep `name: CI` and the same
  triggers**, because `claude-review.yml` runs `on: workflow_run: workflows: ["CI"]`. Do not rename the workflow.
- **Jobs shipped by this PR:** `quality` (checkout → `pnpm/action-setup` v6 — no `version:` input, so it
  installs the pnpm pinned by `packageManager` (there is no v12 of that action, only of pnpm itself) →
  `actions/setup-node` cache `pnpm` → `pnpm install --frozen-lockfile` → `pnpm build:packages` →
  `pnpm lint && pnpm typecheck`), `unit` (`pnpm build:packages` →
  `pnpm coverage` — the **unit** configs only,
  no Postgres service, so it can only enforce the pure-code rows of the §14 table; it uploads `coverage-unit/`),
  `build` (`pnpm build` only — **no `docker build` yet**, because
  `docker/Dockerfile` does not exist until PR-18).
- **Jobs added later (same file, additive edits — the rule in §14):** `integration` is added by **PR-04** (it runs
  `pnpm test:integration`, which needs the integration config + first tests from that PR, and it is the job that runs
  `pnpm coverage:integration` — see the coverage rule in §14), the `docker build` smoke
  step is added to `build` by **PR-18**, and `e2e` (Playwright, `pnpm exec playwright install --with-deps chromium`,
  `apps/web/dist` + API in one job) is added by **PR-19**. A job never enters `CI.yml` before the files it runs exist.
- **Acceptance:** the three jobs this PR introduces pass on a PR that touches nothing but the workflow;
  `pnpm install --frozen-lockfile` succeeds
  (so `pnpm-lock.yaml` must be committed); a deliberately failing test in a throwaway branch is proven red;
  concurrency + `permissions: contents: read` retained; the Claude review workflow still triggers (verify via the
  `workflow_run` listing after merge).
- **Out of scope:** deployment/publishing, main-branch Docker image push.

#### PR-04 — DB schema, migrations, repository harness
**Branch:** `feat/pr-04-db-schema` · **Size:** L · **Depends on:** PR-01, PR-02

- **Create:** `apps/server/drizzle.config.ts`, `db/schema.ts` (all tables + indexes from §8), `db/client.ts`,
  `db/migrate.ts` (+ wire into `index.ts` bootstrap), first migration in `migrations/`, `test/helpers/db.ts`
  (spin/truncate against `DATABASE_URL`, transaction-per-test or truncate-all fixture), `test/helpers/app.ts`,
  `test/fixtures.ts` (creates users with raw schema inserts — the auth-shaped `users.repo.ts`/`sessions.repo.ts` come
  in PR-07, per §7 — and it needs **two** users for the cross-user cases: one `role='owner'`, one `role='member'`, both
  written explicitly, because a fixture that omits `role` twice under §8's one-owner index is an accident waiting to
  collide rather than a test), `docs/DATA-MODEL.md`, repositories for `folders` and `notes`
  (the notes repo stores **opaque** `content_cipher`/`content_iv`/`key_version` triples supplied by its caller — it never
  sees plaintext, because the schema has no plaintext representation; PR-04's tests insert fixed test blobs, and PR-06
  plugs the real `crypto/envelope.ts` in behind the same interface). It also **adds the scripts** the PR-01 contract
  requires: `db:generate` = `NODE_ENV=development drizzle-kit generate`, `db:migrate` =
  `NODE_ENV=development drizzle-kit migrate` (apps/server, root passthrough), and `test:integration` /
  `coverage:integration` = `NODE_ENV=test vitest run --config vitest.integration.config.ts`. Without the inline
  `NODE_ENV` these commands would hit §10's missing-`NODE_ENV` failure or run with the loader disabled, and the
  acceptance below could not pass (PR-01's rule, §16's gate). It also creates
  **`apps/server/vitest.integration.config.ts`**
  with `include: ['src/**/*.int.test.ts']` — the only config that reads `DATABASE_URL` — and one of the two host entry points that must call PR-01's
  `loadDevEnvFile()` + `databaseUrl()` themselves (its Vitest setup file, plus the top of `drizzle.config.ts`: neither
  Vitest nor drizzle-kit imports `env.ts` on its own, so without those calls `pnpm test:integration` and
  `pnpm db:migrate` would ignore an edited `.env` and build the DSN from whatever the shell happened to export —
  §16) — and every DB-backed file it adds
  (`db/repositories/*.int.test.ts`) carries that suffix, which is what keeps `pnpm test` and the Postgres-free `unit` job
  green from here on (§14's split rule, pre-configured in PR-01).
  Also **modify `.github/workflows/CI.yml`** to add the `integration` job (`services: postgres:16` + `DATABASE_URL` →
  `pnpm test:integration`, and the new `pnpm coverage:integration` step that produces the DB-dependent coverage numbers —
  §14) — this is the PR that makes that job meaningful (see PR-03).
- **Acceptance:** `pnpm db:generate && pnpm db:migrate` idempotent on a fresh and existing DB — run from a shell with
  **nothing exported** (`env -u NODE_ENV -u DATABASE_URL -u POSTGRES_USER … pnpm db:migrate`, or the same via a
  `env -i` subshell with only `PATH`), against the repo-root `.env` a cold clone has (`cp .env.example .env`, which
  ships `POSTGRES_*` and `HOST_PORT` but **no** `DATABASE_URL`, §16). That command succeeds **only because** the
  script itself contributes `NODE_ENV=development` — the inline assignment beats an empty or absent parent value, which is
  exactly why the negative half of the test matters: running the tool **without** the script
  (`env -u NODE_ENV pnpm exec drizzle-kit migrate`, and pnpm injects no `NODE_ENV` of its own — verified on pnpm 12.3.4
  with Node 22.22) must exit non-zero with §10's missing-`NODE_ENV` message. That pair is the regression test the loader
  needs: without it a future edit that drops the inline mode silently disables `loadDevEnvFile()` and this whole block
  goes vacuously green. Two further assertions, because a DSN and its
  parts are different levers:
  (a) flip `POSTGRES_PORT` there (and recreate the dev `db`) and `pnpm db:migrate` follows it — true only because
  `env.ts`'s `databaseUrl()` derives the DSN from `POSTGRES_*` when `DATABASE_URL` is unset, which is what makes
  `loadDevEnvFile()` visible inside the drizzle-kit path at all;
  (b) put a literal `DATABASE_URL=…:5433/notetaker_test` in the same `.env` and the same command targets *that* string
  verbatim (`process.loadEnvFile` does no `${VAR}` expansion, §16), which is also how the CI `integration` job's exported
  `DATABASE_URL` wins; integration tests
  prove: sibling uniqueness (folder & note), **root-level rows work** (`folders.parent_id IS NULL` and
  `notes.folder_id IS NULL` insert, and two root notes with the same name collide while a root note and a note inside
  a folder do not), cascade delete of nested folders, `notes.version` conditional update
  returns 0 rows on stale `baseVersion`, cross-user select returns nothing, and **`users_one_owner_uidx` rejects a second
  `role='owner'` row** (a raw two-row insert that states `role` raises a unique violation) — the invariant PR-07's
  setup-race test relies on, proven here at the schema layer where it actually lives. And the §8 default itself: a raw
  insert that omits `role` lands as `'member'`, so two role-less fixture users coexist and neither is an owner.
- **Tests:** ≥ 15 integration assertions; the `apps/server/src/db` row of the §14 table (≥ 80% lines) is enforced here
  for the first time — by **`pnpm coverage:integration`** in the `integration` job, since these files are only exercised
  against a real DB.
- **Out of scope:** HTTP routes, auth, crypto.

#### PR-05 — Shared contracts (Zod DTOs, error envelope, typed client)
**Branch:** `feat/pr-05-contracts` · **Size:** M · **Depends on:** PR-01
*(Unblocks PR-06…PR-17 — PR-06 imports the contracts to seal/unseal — land it as early as possible; it is the contract the parallel tracks build against.)*

- **Create:** the whole `packages/contracts` package per §7 — **with a real build/export story, not just TS sources**:
  `packages/contracts/package.json` (`"type": "module"`, `"main"`/`"types"` and `"exports"` all pointing at `./dist/index.js`
  / `./dist/index.d.ts`, `"scripts": { "build": "tsc -p tsconfig.json"` (emits `dist/` + declaration files)`, test, … }`),
  `tsconfig.json` extending the base with `outDir: "dist"`, `declaration: true`. The server imports it as
  `@note-taker/contracts`; at runtime that must resolve to **compiled JS**, because PR-18's stage 2 never executes `.ts`.
  Root `pnpm build` therefore builds workspaces in dependency order (`pnpm -r --filter './packages/**' build && pnpm -r
  --filter './apps/**' build`, or `pnpm -r build` once every workspace has a `build` script);
  `pnpm -w typecheck` resolves `@note-taker/contracts` through those same `exports`, so it only succeeds **after**
  `pnpm build:packages` — the root script PR-01 defines and PR-03 wires into every typecheck/test job (§14). Nothing aliases
  the package to its sources (no `paths` mapping, no Vitest alias, no `development` export condition), so the dist-backed
  resolution is identical in dev, CI, and the production image; `pnpm dev` rebuilds packages on start for the same reason,
  and iterating on contracts means a fourth terminal running `pnpm --filter @note-taker/contracts build -- --watch`.
  + `docs/API.md` documenting §9 with request/response
  examples; `apps/web/src/lib/api.ts` typed fetch wrapper (`json()`, `ApiError`, CSRF header injection, 401
  handling hook, **and the §10 one-shot CSRF recovery**: on a `403` from a mutation it re-fetches `/api/auth/status` once
  and replays **once**, never twice) and `queryClient.ts`. The client rule belongs here because this PR owns the file;
  the server that answers it is PR-07, so PR-05 pins it with a mocked `fetch` (403 ⇒ exactly one status refetch ⇒
  exactly one replay ⇒ a second 403 surfaces the error), and PR-07 proves the pair against the real guard. It also owns the server-side error plumbing the §9.1 envelope needs before any
  route exists: `apps/server/src/domain/errors.ts` (typed domain errors: `NotFoundError`, `ConflictError`,
  `VersionConflictError`, …) and `apps/server/src/plugins/error-handler.ts` (Zod / Drizzle / domain error → envelope —
  including Postgres `40001`/`40P01` → `CONFLICT`, §9.1 —
  registered inside `buildApp()`). Later PRs only *add mapping cases* to those two files — they never re-create them.
- **Key content:** `names.ts` =
  `NOTE_NAME_MAX=120`, `NOTE_NAME_RE` (no `/ \ : * ? " < > |`, no control chars, no leading/trailing space, no `.`/`..`,
  **and no stripped name that still ends in `.md`** — A.1: `stripMd` removes exactly one suffix, so `foo.md.md` must be
  rejected rather than stored as `foo.md`),
  `newFileName(msEpoch) => \`new-file-${msEpoch}.md\``, `stripMd(name)` (drops a trailing `.md`, case-insensitive),
  `withMd(name)` (display-only re-append), `uniquify(name, taken)` (operates on the stored, extension-free base:
  `plan` → `plan-2` → `plan-3`), plus `createNoteSchema.superRefine` enforcing them; folder name rules (no extension
  handling).
- **Acceptance:** `pnpm build` produces `packages/contracts/dist/index.js` + `index.d.ts`, and
  `node --input-type=module -e "import('@note-taker/contracts').then(m => console.log(typeof m.createNoteSchema))"` run
  from `apps/server` prints `object` — proof the compiled server can resolve the package at runtime with nothing from
  `src/` involved;
  `pnpm -w typecheck` resolves contracts from both apps **only after `pnpm build:packages` has run** — this PR turns that
  PR-03 step from a no-op into a requirement, and the acceptance includes the negative control: with `packages/contracts/dist`
  deleted, `pnpm -w typecheck` fails to resolve `@note-taker/contracts` (proof that `exports`→`dist` is what CI is relying
  on, §14) — and the positive half of the same check: **`pnpm i && pnpm dev` from a bare clone still boots** now that the
  server really imports the package, which only holds because `dev` runs `build:packages` first (PR-01). Without that
  prefix `tsx`/`vite` fail to resolve `@note-taker/contracts` on a fresh checkout, i.e. the dev path and the CI path are
  kept honest by the same assertion; contract unit tests cover name rules
  (unicode, 121 chars, path chars, existing sibling, **and the stripped-name edge cases from A.1: `"..md"` and `"foo .md"`
  are rejected because every rule runs on `stripMd(name)`, while `"foo.md.md"` and `"foo.md.MD"` are rejected because the
  stripped result *still* ends in `.md`** — the case that would otherwise store `foo.md` and render it identically to the
  stored note `foo`), the **strip-idempotence** property (`isValidNoteName(n) ⇒ stripMd(stripMd(n)) === stripMd(n)`,
  equivalently `!endsInMd(stripMd(n))`; stated over already-stored names that is `stripMd(stored) === stored`. It is
  deliberately **not** `isValidNoteName(n) ⇒ stripMd(n) === n` — that is false for `Draft.md`, which A.1 accepts and
  `stripMd` shortens), the collision property (two distinct stored names never render to the same `withMd()` display
  string), error envelope typing, `uniquify` sequences (`plan` → `plan-2`, never `plan.md-2`).

- **Tests:** besides the contract unit tests, this PR writes the first **web** unit tests: `apps/web/src/lib/api.ts`
  driven by a mocked `fetch` — CSRF header echoed from the cookie, `ApiError` shape, the one-shot 403 recovery (exactly
  one status refetch, exactly one replay, second 403 surfaces the error) and the 401 hook. Those tests are what arm the
  `apps/web/src/lib` row of §14's threshold table, so PR-05 adds that row's thresholds to
  `apps/web/vitest.config.ts` and drops PR-01's `passWithNoTests: true` (the overall `apps/web/src` row still waits for
  PR-08's components).
- **Coverage:** ≥ 90% lines and ≥ 85% branches in `packages/contracts` (the `packages/contracts` row of the §14
  threshold table: 90/90/85/90 here, ratcheting to 95 across the board after PR-19; pure module, no excuse, and it is a
  `unit`-job scope because contracts needs no DB).
- **Out of scope:** server route registration (comes with each route PR).

#### PR-06 — Envelope encryption module + key management + rotation script
**Branch:** `feat/pr-06-encryption` · **Size:** M · **Depends on:** PR-04, PR-05

- **Create:** `crypto/keys.ts` (parse `NOTE_ENCRYPTION_KEY` — or read the key from `NOTE_ENCRYPTION_KEY_FILE` when set, so a
  mounted secret file works without shell interpolation — plus `NOTE_ENCRYPTION_KEY_PREVIOUS` and
  **`NOTE_ENCRYPTION_KEY_VERSION`** (integer, default `1`): the version tag stamped into `notes.key_version` for the
  *current* key. It is **explicit, never derived** — deriving it as `max(previous)+1` resets to 1 the moment `_PREVIOUS`
  is dropped, which silently makes every version-2 row undecryptable. The keyring is therefore
  `{current: {version: NOTE_ENCRYPTION_KEY_VERSION, key}, previous: Map<version, key>}`, which is exactly what A.3's
  `keyring.current.version` reads; and, **only** when
  `NODE_ENV` is `development`/`test` and neither is set, generate one key on first boot and persist it to
  `.dev/note-key` (mode `0600`, dir created on demand, `.gitignore` + `.env.example` comment updated) so dev/test rows
  survive restarts — production never takes this path, §10), validate 32 bytes,
  expose `keyring`, fingerprint log), `crypto/envelope.ts` (`encrypt(plain, {keyVersion, aad}) → {cipher, iv,
  keyVersion}`, `decrypt(...)`, `sealNoteContent()/openNoteContent()`), refactor `notes.repo.ts` to store
  `content_cipher/content_iv/key_version/content_bytes/word_count`, root `scripts/generate-keys.ts` (dev/CI only — prints
  a fresh key to stdout; §15 gives the `docker run --rm node:22-slim …` one-liner as the operator-facing equivalent),
  and **`apps/server/src/scripts/rotate-note-key.ts`** — the operator-facing rotation script. It lives under
  `apps/server/src/` on purpose: it is TypeScript inside the server workspace, so `pnpm build` (`tsc`) emits
  `apps/server/dist/scripts/rotate-note-key.js`, which the PR-18 image copies. It has **no dev-only dependency** (only
  `db/client.ts`, `crypto/*`, `env.ts`), streams rows, re-encrypts, batches in transactions, is idempotent, supports
  `--dry-run` and `--verify`, and is invoked in production with
  `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js`
  (same DB connection, same keyring, no extra network exposure — the prod `db` publishes no port).
  **The script runs against a live app, so it must not lose concurrent edits** (autosave is writing the whole time; §11.4
  autosaves within 1.2 s — the §11.4 debounce — and step 3 of §15 puts the app back into service *before* the rewrite runs). Per batch, in one
  transaction: `SELECT id, version, key_version, content_cipher, content_iv FROM notes WHERE key_version < $current
  ORDER BY id LIMIT $batch FOR UPDATE` — the row lock is what makes the read-and-reseal atomic — then the write is
  conditional, exactly the A.2 shape:
  `UPDATE notes SET content_cipher=…, content_iv=…, key_version=$current, updated_at=now() WHERE id=$1 AND version=$2
  AND key_version=$old_version`. If a row's UPDATE matches 0 rows, the row changed under the script: **re-read it and
  re-seal the freshly read ciphertext** (never write the previously buffered one), or skip it and let the next run pick it
  up — `--verify` then reports any row still on an old version, so the operator re-runs until it exits 0. The script never
  touches `notes.version` (rotation is not a content edit, and bumping it would spuriously trip every open tab's autosave
  into a 409). `.env.example`
  additions. The ADR-0002 write-up itself belongs to PR-20 (§7 maps every file to one PR); this PR only leaves a
  `// ADR-0002` comment in `crypto/envelope.ts` pointing at where it will land.
- **Acceptance:** every assertion here is made at the layer this PR owns — `crypto/*`, `notes.repo.ts` and the compiled
  script — because **no route exists yet** and the routes that would exercise this code (PR-09's `POST /api/notes` /
  `GET /api/notes/:id`, PR-10's `PUT /api/notes/:id/content`) depend on this PR, so anything HTTP-level here would be
  unmeetable at merge time. Round-trip test; tamper test (flip a ciphertext byte ⇒ `decrypt()` throws — the route-level
  mapping of that failure, `INTERNAL` + logged note id + never blank content, is asserted in **PR-09**); wrong-key test;
  **key-version rules**: the current key's version comes
  from `NOTE_ENCRYPTION_KEY_VERSION` (default `1`) and is written into every new row; the **script** re-encrypts rows and
  stamps them with the current version; the version/key edits in `.env` and the `up -d` restart are **operator steps**
  (the script cannot change its own container's environment — §15 numbers them), so acceptance drives the script with an
  env that already carries `NOTE_ENCRYPTION_KEY_VERSION=2` + the old key in `_PREVIOUS`, runs it, then asserts every row
  now carries version 2 (row counts per `key_version` before/after — none keeps the old tag) and that rows written under
  version 1 still decrypt while that entry stays in `_PREVIOUS`; removing a still-referenced `_PREVIOUS` entry makes
  exactly those rows unreadable (the lossy case the explicit version prevents);
  server refuses to boot in production when neither `NOTE_ENCRYPTION_KEY` nor a readable `NOTE_ENCRYPTION_KEY_FILE`
  yields 32 bytes; `sealNoteContent('')`/`openNoteContent()` round-trip the **empty string** into a valid envelope
  (the schema never holds a NULL/empty cipher or iv — `sealNoteContent` always emits a 12-byte IV + 16-byte tag);
  **dev-key path**: with `NODE_ENV=development` and no key
  configured, `.dev/note-key` is created with mode `0600`, the logged fingerprint is identical on the next boot (so rows
  survive a restart), and with `NODE_ENV=production` the same setup still exits non-zero instead of writing `.dev/`; a
  note written with a generated key is unreadable after the key file is deleted, which is the documented dev caveat.
- **Tests:** ≥ 12 unit assertions (including AAD mismatch across two note ids ⇒ `decrypt()` fails) **plus the
  rotation-concurrency integration test**, driven through the layer this PR actually has: two writers against a real DB,
  `rotate-note-key.ts` running as a **tsx subprocess — not `dist/scripts/rotate-note-key.js`**, because the `integration`
  job runs `pnpm build:packages` only (§14) and the compiled form is not on disk there; the compiled `.js` is asserted
  where a real build exists (the `build` job, and PR-18's image copy). The race itself: `rotate-note-key.ts` runs while a
  second writer calls the **repository's conditional update** (the A.2 shape —
  `UPDATE notes SET … WHERE id=$1 AND version=$2`, the very statement PR-10's route will wrap) on the same row. Assert
  the note's final content is the *writer's* (not the script's stale buffer), sealed at the current `key_version`,
  `notes.version` incremented exactly once, and `--verify` exits 0 afterwards. Without the row lock / conditional write
  this test fails, which is the point. The same race is re-tested at the HTTP level in **PR-10** (where
  `PUT /api/notes/:id/content` exists) — that is a second look at the same guarantee, not its only proof.
- **Out of scope:** per-user keys, KMS integration.

#### PR-07 — Auth core (users, sessions, cookies, CSRF, rate limit, guards)
**Branch:** `feat/pr-07-auth-api` · **Size:** M · **Depends on:** PR-04, PR-05

- **Create:** `db/repositories/{users,sessions}.repo.ts` final forms, `services/auth.service.ts`,
  `routes/auth.routes.ts` (§9.2 #2–#9: status/setup/**register**/login/logout/**logout-all**/session/password),
  `routes/users.routes.ts` (§9.2 #10/#11),
  `plugins/auth-guard.ts`, `plugins/csrf.ts`, `http/rate-limit.ts`, argon2 hashing utils, `auth_attempts` writes.
  **Every account-creating path (`setup`, `register`, `POST /api/users`) writes `role` explicitly — `setup` is the only `'owner'` writer, the other two
  are always `'member'` and never left to the column default (§8) — and inserts the default `settings` row in the same
  transaction as the `users` insert** — `settings.user_id` is the PK (§8), there is no trigger, and PR-07 is the PR that
  owns user creation, so the row cannot be left to PR-09 (which merges later) or to the settings UI (PR-16): an owner
  created here would otherwise have no row for `GET /api/settings` to read and `PATCH /api/settings` would match zero
  rows, which is exactly what PR-14's autosave flag and PR-16 then break on. The insert is plain Drizzle on the
  `settings` table from `db/schema.ts` (PR-04); `settings.repo.ts` itself still lands in PR-09.
  `POST /api/auth/register` exists to make `ALLOW_REGISTRATION` real: 403 when the flag is false, **403 while no
  `role='owner'` row exists** (a fresh DB is bootstrapped by `/setup` only — otherwise the first visitor self-signs-up as a
  `member`, which would flip `needsSetup` and lock `/setup` out, leaving the install with no owner: §8 invariant, §9.2 #2/#4),
  rate-limited like login, creates `role='member'`. `GET /api/auth/status` returns `{needsSetup, registrationOpen}`, with
  `needsSetup` meaning “no owner row”, so the SPA offers the signup form only when `registrationOpen && !needsSetup`.
  **`apps/server/src/scripts/reset-password.ts`** — the only supported password recovery. It is a compiled server-side
  script (same rule as `rotate-note-key.ts`: lives under `apps/server/src/`, ships in the image, run with
  `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/reset-password.js <username>`,
  reading the new password from `argv` or a prompt, never from the URL) that **only** updates `users.password_hash` +
  `password_set_at` and `DELETE`s that user's `sessions` rows. It must not touch anything else: every other `user_id` FK
  is `ON DELETE CASCADE`, so deleting a user row would destroy their folders, notes and settings, and
  `POST /api/auth/setup` refuses to run once an **owner** exists — deleting-and-re-setting is not a recovery path, it is
  data destruction followed by a blocked endpoint.
- **Acceptance:** integration tests: first-run `needsSetup=true` → `setup` creates owner + session; `setup` after
  that ⇒ `CONFLICT`; login success/failure (uniform 401 `UNAUTHORIZED` message); cookie flags asserted in responses;
  logout invalidates (subsequent `GET /api/auth/session` → `user:null`); password change kills other sessions;
  11th login *attempt* in 15 min ⇒ 429, including one carrying the right password; missing CSRF header on a
  mutation ⇒ 403; session expiry honored.
  **First-run race:** two `POST /api/auth/setup` calls issued concurrently against an empty DB ⇒ exactly one `200` + one
  `CONFLICT`, and `SELECT count(*) FROM users WHERE role='owner'` is **1** (the loser is caught by
  `users_one_owner_uidx`, §8 — proving the guard is the index and not the `needsSetup` read).
  **CSRF lifetime/re-issue (§10):** a stale or missing `note_csrf` cookie is re-issued by `GET /api/auth/status` and by
  every `setup`/`login`/`register`/`logout` response (assert the `Set-Cookie` on each), the cookie carries `Max-Age=1 day`,
  and a mutation that fails the check gets `403`. PR-07 adds **no `apps/web` files** — the client half of that rule is
  PR-05's one-shot refresh-and-replay in `apps/web/src/lib/api.ts` (§7, §10) — so the assertion here is that the
  re-issued cookie actually lets PR-05's replay succeed: a mutation with a stale token gets `403`, the status refetch
  re-issues `note_csrf`, the single replay then succeeds.
  Registration matrix (the flag must have an implementation): with `ALLOW_REGISTRATION=false`,
  `POST /api/auth/register` ⇒ 403 and accounts can only be created by the owner via `POST /api/users`; with
  `ALLOW_REGISTRATION=true`, `register` creates a `member` + session, `registrationOpen=true` in the status payload,
  and `register` still never creates the first `owner`: **on an empty DB with the flag true, `POST /api/auth/register`
  answers 403 and `GET /api/auth/status` still reports `needsSetup: true`; only after `POST /api/auth/setup` does register
  succeed.** Missing that guard leaves an install with zero owners, `/setup` permanently `CONFLICT`, and the owner-only
  `POST /api/users` unreachable (§8, §9.2 #2/#4).
  **Default `settings` row per account:** after `setup`, after `register` (flag true, owner already exists) and after
  `POST /api/users`, `SELECT * FROM settings WHERE user_id = <new user>` returns exactly **one** row carrying §8's
  defaults (`autosave = true`, `theme = 'system'`), because the user insert and the settings insert share one
  transaction — and a user insert that is rolled back leaves no orphan settings row behind. Asserted here, not in PR-09:
  PR-07 owns every account-creating path and merges first, while PR-09's `GET /api/settings`, PR-14's autosave flag and
  PR-16's UI are the consumers that assume the row already exists.
  `reset-password.ts` (executed as a **tsx subprocess** against the test DB — same integration-job build rule as PR-06's
  rotation test, §14: `build:packages` only, so nothing here may assume `dist/scripts/`): unknown username ⇒ non-zero
  exit and no writes;
  success ⇒ the new password logs in, **all** of that user's sessions are gone, and that user's
  `folders`/`notes`/`settings` rows are untouched — the regression guard against anyone "simplifying" recovery into
  deleting the user row.
- **Out of scope:** login UI (PR-08), passkeys (backlog), OAuth/2FA.

#### PR-08 — Auth UI (setup, login, sign-up, session context, route guards, UI kit v1)
**Branch:** `feat/pr-08-auth-ui` · **Size:** M · **Depends on:** PR-05, PR-07
*(Can start against mocked handlers right after PR-05.)*

- **Create:** `routes/{setup,login}.tsx` plus `routes/signup.tsx` (rendered only when the status payload reports
  `registrationOpen: true` and driving `POST /api/auth/register` — closing the loop PR-07 opens),
  `routes/welcome.tsx` (a minimal signed-in card with the username + a sign-out button: the **placeholder home this PR
  owns**, because the `/app` shell and its guard belong to PR-12), `features/auth/*`,
  `components/ui/*` (Button, Input, Field, Dialog, Menu, Toast, Spinner — Radix primitives + Tailwind),
  Tailwind theme tokens (light/dark via `prefers-color-scheme` default), global error/not-found boundaries. It also
  **arms the rest of the web coverage gate**: it adds the overall `apps/web/src` row of §14's threshold table to
  `apps/web/vitest.config.ts` (the `apps/web/src/lib` row was armed by PR-05, and PR-01's `passWithNoTests: true` was
  dropped there — from PR-05 on, an empty web suite is a failure, not a pass).
- **Acceptance (playwright-able, against routes this PR owns):** unauth visit → `/login`; `needsSetup` → `/setup`;
  wrong password shows the server message; success lands on **`/welcome`**; refresh keeps the session; the sign-out
  control on `/welcome` returns to `/login`; `/login` when authed redirects to `/welcome`; password inputs have labels
  + autocomplete attrs; Vitest component tests for the form validation + error rendering. With
  `ALLOW_REGISTRATION=true` **and an owner already exists** the login page links `/signup` and the form creates a member +
  lands on `/welcome`; with the flag false, `/signup` is not reachable from the UI and a direct visit redirects to `/login`;
  on a **fresh install** (flag true, `needsSetup: true`) the link is hidden too and a direct `/signup` visit redirects to
  `/setup` — the UI mirror of PR-07's 403, so nobody can walk into the no-owner dead end through the browser.
- **Out of scope:** the `/app` shell, `routes/app/route.tsx` and every `/app` assertion (PR-12, which also deletes
  `routes/welcome.tsx`), settings page (PR-16).

#### PR-09 — Folders & notes CRUD API + tree
**Branch:** `feat/pr-09-notes-api` · **Size:** L · **Depends on:** PR-05, PR-06, PR-07 (schema from PR-04; PR-06 is a
hard dependency because `POST /api/notes` must seal content — even the empty string — and `GET /api/notes/:id` must
decrypt it)

- **Create:** `db/repositories/{folders,notes,settings}.repo.ts` final forms (they start in PR-04; this PR finishes
  them), `services/{folder,note,tree,settings}.service.ts`,
  `routes/{tree,folders,notes,settings}.routes.ts`, `domain/name.ts`. `domain/errors.ts` and
  `plugins/error-handler.ts` are **created in PR-05**; here they only gain the extra mapping cases (name clash ⇒
  `CONFLICT`, cross-user ⇒ `NOT_FOUND`).
  **`GET /api/notes/:id` (§9.2 #17) is created here**, not in PR-10: it returns metadata + decrypted `content` +
  `version` with `ETag: W/"v<version>"`. PR-10 owns only the write side (`PUT /api/notes/:id/content`).
  `POST /api/notes` always seals through `crypto/envelope.ts` (PR-06) — `seal(content ?? '')` — so a note created
  without content still stores a valid 12-byte IV + 16-byte tag.
  `scripts/seed-demo.ts` (idempotent demo user + tree, guarded by `NODE_ENV !== 'production'`) wired to a new
  `pnpm db:seed` script — `NODE_ENV=development tsx scripts/seed-demo.ts`, the inline mode PR-01's rule requires so
  the loader and `databaseUrl()` are actually active when it runs (§16) — the earliest point at which a seed can hash a
  password (PR-07) and write real
  `folders`/`notes` rows.
- **Settings API lands here, not in PR-16:** `GET /api/settings` + `PATCH /api/settings` (§9.2 #22). The **row** is not
  created here: PR-07 inserts it in the same transaction as every `users` insert (PR-07 Create + Acceptance), because
  that PR owns account creation and merges first. `settings.service.get()` is still **get-or-create** —
  `INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING` then select — so a user that predates or
  bypasses PR-07 (PR-04's raw-insert fixtures, the seed script, a hand-restored row) reads §4 defaults instead of a 404,
  and `PATCH` can never match zero rows. PR-14 must honor `settings.autosave`, and PR-16 depends on PR-14, so an API
  that only lands in PR-16 would be circular. PR-16 keeps the settings **UI** (page, theme, change-password form).
- **Behavior:** `GET /api/tree` one recursive CTE (ordered folders-then-notes, `name` collation `C`);
  create/rename/move with sibling-uniqueness ⇒ `CONFLICT` (body carries the conflicting `id`); move-to-self/descendant
  ⇒ `CONFLICT`. **Depth cap:** the tree is capped at 100 levels — root folders sit at depth 0, legal folders occupy
  depths 0…99, and any create or move that would put a folder below depth 99 answers `VALIDATION` naming the cap
  (checked inside the per-user advisory lock below). A *create* needs only the destination parent's depth — the same
  upward ancestor walk as the cycle guard. A *move* must also measure what it carries: the check is
  **`depth(newParent) + 1 + height(moved subtree) ≤ 99`**, the height coming from a **downward** recursive walk from
  the moved folder, because the upward walk alone would pass a whole deep subtree re-parented under a shallow root
  and drop its tail below the CTE's guard. That cap is what makes the A.4 CTE's `depth < 100` guard a
  runaway belt rather than a silent truncation: no folder the API ever accepted can sit where the CTE stops walking,
  so `GET /api/tree` can never drop a legal subtree with its notes.
  **Every folder mutation (create / rename / move / delete) opens its transaction with
  `SELECT pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text))`** — one lock per user, held to commit —
  so the ancestor-walk cycle check runs against a tree no concurrent move is changing. Row locks on the two affected
  folders are *not* sufficient: two moves can lock disjoint pairs (`X` under `Y` while `Z` under `W`, where `Y ⊂ Z` and
  `W ⊂ X`), each ancestor walk passes against committed state, and a four-node cycle commits. And because a move takes
  exactly one advisory lock, the opposite-order acquisition that makes Postgres abort one side of an `A↔B` pair with
  `40P01` cannot occur; a `40001`/`40P01` arriving from any other path maps to a retryable `CONFLICT` (§9.1), never
  `INTERNAL`. Delete folder requires `cascade=true` when non-empty; `POST /api/notes` with no `name` generates
  `new-file-<msepoch>` then `uniquify`; cross-user id in any path, query **or body** ⇒ `404` — a `folderId`/`parentId`
  pointing at another user's folder is caught by the service's scoped lookup (the FKs do not carry `user_id`, §8), and
  never surfaces as an FK-violation `500` nor as `403`.
- **Acceptance:** integration suite covers each behavior above plus: 3-level nesting, rename into a sibling
  occupied name, move folder A under its own child B rejected, cascade delete removes nested notes (and content
  rows), **create at root (`folderId: null`) and move a note back to root both work**, a 99-deep chain (the cap's
  last legal level) renders **complete** through `GET /api/tree` — every folder and note present, nothing truncated at
  the CTE's `depth < 100` guard — and **the cap is an error, not a silent drop**: `POST /api/folders` under the deepest
  folder answers `VALIDATION` naming the limit, and so does the case a destination-depth check alone cannot see —
  root folder `F` whose subtree reaches depth 99 moved under a **different root** folder `R` (the upward walk finds `R`
  at depth 0, yet `F`'s tail would land at depth 100): the subtree-height check rejects it and the tree is
  byte-identical afterwards. It also covers **the cross-user body-id case the FKs cannot
  catch**: user A and user B each create a folder, then B sends `POST /api/notes {folderId: A's}`,
  `POST /api/folders {parentId: A's}`, `PATCH /api/folders/:id {parentId: A's}` and
  `PATCH /api/notes/:id {folderId: A's}` — every call answers `404 NOT_FOUND`, nothing is created or moved, and A's
  subtree is byte-identical afterwards (§8; no FK-violation `500`, no existence oracle).
  **Move-cycle race — two cases, not one.** (a) *Adjacent pair, started as siblings:* folders `A` and `B` **both at root**,
  then `PATCH /api/folders/A {parentId: B}` and `PATCH /api/folders/B {parentId: A}` fired through `Promise.all`. Each move
  is legal alone and illegal together, so “exactly one commit lands, the other answers `CONFLICT`” is a meaningful
  assertion; start them nested (`B` inside `A`) and the first request is rejected by the plain cycle check without any
  locking, which tests nothing. Afterwards the `GET /api/tree` walk must terminate and both folders stay reachable.
  (b) *Disjoint locks — the case (a) does not catch:* four folders with `Y ⊂ Z` and `W ⊂ X`, fired as
  `PATCH /api/folders/X {parentId: Y}` and `PATCH /api/folders/Z {parentId: W}` concurrently. The first re-parents `X`
  under `Y` (chain `X→Y→Z`), the second re-parents `Z` under its own descendant `W` (`Z→W→X`); together that closes
  `X→Y→Z→W→X`, and it is exactly the pair that a design locking only the moved folder plus its new parent lets through —
  the two lock sets share no row, so both ancestor walks pass against committed state and both commit. (Moving `W` instead
  of `Z` — `PATCH …/W {parentId: Z}` — only re-parents `W` and leaves a legal tree, so it cannot be this test.) With the
  per-user advisory lock the second transaction waits, then its walk sees the committed state and answers `CONFLICT`.
  Assert that neither interleaving leaves a cycle, that exactly one write lands in each case, and that the loser gets
  `CONFLICT` — never an unmapped `40P01`/`INTERNAL`.
  **The route-level crypto assertions live here, not in PR-06** — this is the first PR whose routes make them
  measurable: `POST /api/notes` with no content stores a real envelope and `GET /api/notes/:id` answers `content: ''`
  (PR-06's empty-string seal, proven over HTTP); and a row whose ciphertext fails authentication — forced by rewriting the
  stored blob directly — makes `GET /api/notes/:id` answer `INTERNAL` with the note id logged and **never**
  blank-or-garbage content (the mapping `plugins/error-handler.ts` gained in PR-05).
  **Settings on a user with no row** (the state PR-04's raw-insert fixtures are in, and the belt for anything that
  bypasses PR-07's transaction): `GET /api/settings` answers §4's defaults with `200` — never `404`, never an empty body —
  and leaves exactly one `settings` row behind, which a second `GET` then reads back; `PATCH /api/settings {autosave:false}`
  on such a user updates **one** row and returns the new value, so the zero-row update this endpoint would otherwise be
  able to produce is asserted impossible here rather than discovered by PR-14's autosave toggle or PR-16's settings page.

- **Tests:** ≥ 25 assertions; `services` coverage ≥ 80% lines (the `{services,db,routes}` row of the §14 table, measured
  by `pnpm coverage:integration` in the `integration` job — it reaches 85% only after PR-19 ratchets the thresholds).
- **Out of scope:** content versioning endpoint (PR-10), search (PR-11), UI (PR-12).

#### PR-10 — Note content read/write with versioning + autosave-safe writes
**Branch:** `feat/pr-10-content-api` · **Size:** M · **Depends on:** PR-06, PR-09

- **Create:** `PUT /api/notes/:id/content` handler + service (`baseVersion` compare in one SQL statement),
  `ETag`/`If-Match` support, `content_bytes/word_count/content_updated_at` maintenance, 1 MiB body limit +
  `PAYLOAD_TOO_LARGE`, concurrent-write test with `Promise.all`. The read side (`GET /api/notes/:id`, §9.2 #17) already
  ships in PR-09; this PR owns only the write path and re-tests the `ETag` round-trip against it.
- **Acceptance:** two clients on the same version ⇒ one 200, one `VERSION_CONFLICT` carrying server `content` +
  `version` — that payload is what lets PR-14 tell a committed-but-unacknowledged write from a real collision (§11.4), so
  an assertion pins both fields on the 409 body; empty-string content allowed (a legitimately emptied note); write with `If-Match` matching a stale
  ETag ⇒ `VERSION_CONFLICT`; `PUT` against a missing or another user's note ⇒ `404`, never `409` (the follow-up scoped read in A.2); no partial writes when the process is killed mid-request (single statement).
  **Re-test of PR-06's rotation-concurrency guarantee, one layer up:** run `rotate-note-key.ts` while a real
  `PUT /api/notes/:id/content` lands mid-rotation — the note ends with the *client's* content at the current
  `key_version`, `version` bumped exactly once, and the rotation's `--verify` still exits 0.
- **Out of scope:** client autosave engine (PR-14).


#### PR-11 — Search API
**Branch:** `feat/pr-11-search-api` · **Size:** M · **Depends on:** PR-10

- **Create:** `services/search.service.ts`, `routes/search.routes.ts`.
- **Behavior:** name/folder-path match via SQL (`ILIKE` on `lower(name)` with escaped `%`/`_`) UNION metadata
  ordering; body match: load up to 500 most recently updated notes for the user, decrypt, case-insensitive
  substring/word match, score (`name hit > body hit > recency`), return ≤ 25 results with an ~120-char snippet
  (snippet generated from plaintext, truncated on a code-point boundary).
- **Acceptance:** integration tests: unicode + accent folding (NFD-strip) for search keys, `%`/`_` treated
  literally, empty `q` ⇒ `VALIDATION`, cross-user isolation, snippet never leaks another user's text, p95 of a
  1 000-note fixture search < 300 ms.
- **Out of scope:** `pg_trgm`/`tsvector` (documented as the scale-out path in ADR-0002 since bodies are encrypted).

#### PR-12 — App shell + folder tree UI (browse, create, rename, move, delete)
**Branch:** `feat/pr-12-tree-ui` · **Size:** L · **Depends on:** PR-08, PR-09
*(Mocks acceptable: `msw`-style handlers built from `packages/contracts` let this start right after PR-09.)*

- **Create:** `routes/app/{route,index}.tsx`, `components/layout/{AppShell,Sidebar,TopBar,StatusBar}.tsx`,
  `components/tree/*`, `features/tree/*`, `components/notes/{RenameDialog,MoveDialog,DeleteConfirm}.tsx`
  (shared dialog forms), `plugins/static-spa.ts` on the server so a built SPA is served from the API port. This PR also
  **deletes `routes/welcome.tsx`** and repoints every authed landing/redirect at `/app` — the hand-off from PR-08's
  placeholder, which is why the `/app` acceptance assertions live here and not in PR-08.
- **Behavior:** expand/collapse persisted per session, keyboard nav (↑↓←→, `Enter`, `F2`, `Del`), context menu +
  "New folder" / "Rename" / "Move to…" (folder tree picker) / "Delete" with typed-name confirm, optimistic
  reorder-free tree (alphabetical), empty state, loading skeletons, error toasts with retry, `role="tree"` plus
  `role="treeitem"`/`aria-selected`/`aria-expanded` semantics, notes shown under their folder with the `.md` suffix visible.
- **Acceptance (Vitest + testing-library):** tree selectors (flatten/sort/indent/ancestors) unit-tested; rename
  optimistic-then-rollback on 409 with inline error; move into own descendant blocked **client-side** and surfaced
  if the server rejects; delete cascade requires exact name; tree renders 500 nodes in < 150 ms (jsdom smoke).
- **Out of scope:** the editor pane (PR-13), note creation dialog (PR-15).

#### PR-13 — Markdown editor pane + toolbar + preview
**Branch:** `feat/pr-13-editor` · **Size:** L · **Depends on:** PR-12, PR-10

- **Create:** `components/editor/{EditorPane,MarkdownEditor,EditorToolbar,PreviewPane}.tsx`,
  `routes/app/note.$noteId.tsx`, `lib/markdown.ts`, note fetch/`queryOptions`, mode switch
  (`split|write|preview`), unsaved-guard on navigation, character/byte counter with 900 KiB warning.
- **Acceptance:** `lib/markdown.ts` unit tests for every toolbar transform (toggle bold on already-bold,
  selection spanning list items, link wrapping URL+text, table insertion, empty selection at EOF, CJK/emoji-safe
  slicing); preview sanitizes `<script>`/`onclick`/`javascript:` hrefs; GFM tables + task lists render; note opens
  by URL directly (deep link) and by tree click; CodeMirror transactions keep native undo working.
- **Out of scope:** persistence wiring (PR-14), WYSIWYG.

#### PR-14 — Autosave engine + save status + conflict UX
**Branch:** `feat/pr-14-autosave` · **Size:** M · **Depends on:** PR-10, PR-13 (+ PR-09 for the real `settings.autosave` value — the engine itself takes it as an injected flag)

- **Create:** `lib/autosave.ts` (pure state machine; `autosave: boolean` is an **injected** input, not fetched here)
  + `useAutosave()` hook, `SaveStatus`, `ConflictBanner`,
  draft mirror in `localStorage`, `visibilitychange`/`pagehide` flush under the §11.4 60 KiB `keepalive` budget
  (never `sendBeacon`). The flag itself is read by the caller from `GET /api/settings` (§9.2 #22, landed in **PR-09**)
  and injected, so this PR needs no settings UI — PR-16 supplies the real value. The read is get-or-create (PR-07 creates the row with the user, PR-09 re-creates it if absent), so a missing settings row can never silently flip autosave here.
- **Acceptance (fake-timer unit tests):** typing 5× in 200 ms ⇒ exactly **one** `PUT`; no write for 2 s idle;
  force-flush at 10 s; flush on unmount; backoff schedule exact; `VERSION_CONFLICT` ⇒ conflict state and the
  buffer is retained; "Keep mine" retries with the fresh server `version`; "Use server" replaces the buffer and
  clears the draft mirror; `autosave: false` injected ⇒ zero automatic writes and the pill says so.
  **Lost-response idempotency (§11.4, the case that makes retry safe):** a `PUT` whose stub commits server-side and then
  drops the response ⇒ the retry replays the same `baseVersion`, the stub answers `VERSION_CONFLICT` carrying **that
  same content** and a bumped `version` ⇒ the machine goes to **`clean`**, adopts the version, never enters `conflict`,
  renders no `ConflictBanner`, and keeps autosaving. Sibling case proving the fork is not a blanket suppress: the same
  `VERSION_CONFLICT` carrying **different** content ⇒ `conflict`, buffer retained. Third case, the one that proves the
  comparison runs against the in-flight snapshot and not the live buffer: an edit lands after the lost response ⇒ the
  payload still matches the snapshot, so the machine adopts the `version` and lands in **`dirty`**, then a second `PUT`
  writes the newer content — never `conflict`, and nothing typed is lost.
  Unload path (§11.4): a 40 KiB dirty buffer on `pagehide` ⇒ exactly one `fetch(…, {keepalive:true})` `PUT` with the
  CSRF header; a 200 KiB dirty buffer ⇒ no unload request attempted, buffer stays dirty, pill stays
  `Unsaved changes`, dirty-guard prompt fires; `navigator.sendBeacon` is never called.
  **Every row of the A.5 table is asserted**, which means at least: an edit landing *while* a `PUT` is in flight ⇒ still
  exactly one in-flight request, and a second `PUT` fires afterwards carrying the newest buffer + newest `version`
  (nothing typed is lost, no two writes ever race each other); `500`/transport error ⇒ `retrying` with the documented
  backoff then a terminal state; `401` ⇒ autosave stops, the app routes to `/login`, the draft mirror still holds the
  text; `403` ⇒ one CSRF refresh + one replay, then surface it; `404` ⇒ the "note deleted elsewhere" state with a
  save-as-new-note escape hatch, never a silent re-create.
- **Live check (documented in the PR body):** type in two tabs, save in one, observe conflict UI in the other;
  reload immediately after typing and confirm the text is present.
- **Out of scope:** merge/diff UI (a plain three-way merge is backlog `PR-25`).

#### PR-15 — New-note dialog with `new-file-<msepoch>.md` prefill
**Branch:** `feat/pr-15-new-note` · **Size:** S · **Depends on:** PR-12, PR-09, PR-13 — the acceptance ends with the
new note open in the editor, so `/app/note/$noteId` must already exist

- **Create:** `components/notes/NewNoteDialog.tsx`, `lib/name.ts`, wire the "New note" buttons in
  `TopBar`/`StatusBar`/tree context menu — **no `Ctrl/Cmd+N` binding**: that chord is browser-reserved (Chromium opens
  a window before the page sees it) and cannot be intercepted (§11.5), so keyboard users reach the dialog through the
  same focusable buttons.
- **Acceptance:** input pre-filled with `new-file-<Date.now()>.md`, caret placed before `.md`, `.md` rendered as a
  non-editable suffix and stripped from the submitted name; live invalid-name message; collision against the tree
  cache disables Create with "name already used in this folder"; creating in the selected folder; after create,
  the note opens focused in the editor and the URL changes; a second dialog opened within the same millisecond
  still gets a unique name (`uniquify`).
- **Tests:** Vitest for `lib/name.ts` + dialog behavior (prefill, suffix immutability, disabled Create).

#### PR-16 — Settings UI (autosave toggle, theme, change-password form)
**Branch:** `feat/pr-16-settings` · **Size:** M · **Depends on:** PR-07, PR-09 (settings API), PR-14

- **Create:** `routes/app/settings.tsx`, `features/settings/*`, theme application (`class="dark"` on `<html>`), and the
  wiring that feeds `GET/PATCH /api/settings` — already shipped in **PR-09** — into `useAutosave()`. No new server
  code here, only a regression test that the flag round-trips into the open editor.
- **Depends on:** PR-07 (change-password endpoint), PR-09 (settings API), PR-14 (the engine that consumes the flag).
- **Acceptance:** toggling autosave off takes effect immediately in the open editor (pill + no debounce writes);
  change-password form validates the current password; the **current session is rotated and survives** — no forced
  re-login, per §9.2 #9 ("rotates + deletes all other sessions"), §10 and PR-07 — while every **other** session of that
  user is deleted, so another tab fails on its next request; the "sign out everywhere"
  control calls `POST /api/auth/logout-all` (§9.2 #7), lands on `/login`, and invalidates every other tab on its next
  request; theme persists across reload and respects `system`.
- **Out of scope:** user management UI beyond the API from PR-07.

#### PR-17 — Search UI
**Branch:** `feat/pr-17-search-ui` · **Size:** S · **Depends on:** PR-11, PR-12, PR-13 — a search result must open the
note, and the note route belongs to PR-13

- **Create:** `routes/app/search.tsx`, search box in `TopBar` (`Ctrl/Cmd+K` focuses the page link in MVP — the global
  handler fires only when the CodeMirror editor is **not** focused; inside the editor the chord belongs to CodeMirror's
  link-insert and must not move focus out of it, §11.3/§11.5),
  results list with breadcrumb path + highlighted snippet, keyboard selection, empty/no-result states.
- **Acceptance:** debounce 250 ms, `?q=` in URL (shareable), clicking a result opens the note, snippets escape HTML;
  the chord precedence is asserted: with the editor focused, `Ctrl/Cmd+K` inserts a link and does **not** focus the
  search link, and with focus anywhere else it focuses the search link without touching any buffer.

#### PR-18 — Production Docker image + compose + env safety + deploy docs
**Branch:** `feat/pr-18-docker-prod` · **Size:** M · **Depends on:** PR-01…PR-17 (needs the whole app — search UI
included, since PR-17 is what closes M3; the image itself can be drafted at PR-12 and rebased onto PR-17)

- **Create:** `docker/Dockerfile` (stage 1 build all workspaces with dev deps + `pnpm build`; stage 2
  `node:22-slim`, **`ENV NODE_ENV=production`** (the runtime image is production by construction — nobody has to remember it),
  `pnpm deploy --prod` or `npm ci --omit=dev` pruned install — which must carry **the compiled `packages/contracts`**
  (its `package.json` + `dist/`, reached through `exports`) so the server's `@note-taker/contracts` import resolves to JS
  and never to `src/*.ts`; stage 1's `pnpm build` produced it because contracts builds before the apps (PR-05, §7).
  Copy `dist`/`migrations` (`dist` includes `dist/scripts/`, which is how the operator scripts in §15 ship), copy
  `apps/web/dist` into the server's static path, `USER node`, `EXPOSE 3000`, `ENTRYPOINT` (
  `docker/entrypoint.sh` is **only** `exec node apps/server/dist/index.js` — no `pnpm`, no `tsx`, no `.ts` execution in
  the runtime layer, because stage 2 is a pruned `node:22-slim` install with no dev toolchain. Env checks and
  migrations run inside the compiled Node bootstrap (`env.ts` + `db/migrate.ts`, wired in PR-01/PR-04, per §6
  "migrations run at container start before `listen()`"); `scripts/check-env.ts` stays a dev/CI convenience whose
  rules are enforced at boot by the compiled `env.ts`),
  with `HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch(…/api/healthz)…"`
  — **no `curl`**: `node:22-slim` does not ship it, and installing it in the runtime layer is out of scope, so the
  probe uses Node's built-in `fetch` (see §10).
  `docker/compose.yml` (`db` + `app`, `db` published **only** internally, the `app` service carrying
  `NOTE_ENCRYPTION_KEY: ${NOTE_ENCRYPTION_KEY:?set NOTE_ENCRYPTION_KEY in the repo-root .env}` so a missing key makes
  `docker compose config` fail at parse time with that sentence instead of handing the container an empty value — this
  is what §15 step 2b's toolchain-free preflight runs on, and it also arms the §10 boot guard by construction,
  `app.ports: "${HOST_PORT:-3000}:3000"` — the **container** always listens on 3000 (`PORT` is pinned to `3000` in
  the service `environment:` so the `HEALTHCHECK` and `EXPOSE` stay true), while `HOST_PORT` in the repo-root `.env`
  is what an operator changes to publish the app elsewhere),
  `depends_on: condition: service_healthy`, named `pgdata` volume, optional `notes-keys` volume for a mounted key
  file, `restart: unless-stopped`, `init: true`, `db` healthcheck via `pg_isready`), `scripts/check-env.ts` — wired as the
  root **`check:env`** script (`NODE_ENV=production tsx scripts/check-env.ts`, §16) and implementing the file-side DSN
  rule of §10 (accepts `DATABASE_URL` **or** the complete `POSTGRES_*` trio) —,
  `docs/DEPLOY.md`
  (one-port mapping, **exactly how to invoke compose with the env file** (see §15: the stack is started with
  `docker compose --env-file .env -f docker/compose.yml`, because Compose otherwise auto-loads `.env` from
  `docker/`, not the repo root), TLS/reverse-proxy recipe, backups: `pg_dump` + key backup, key-rotation procedure,
  upgrade procedure, troubleshooting table).
- **Acceptance:** `docker compose --env-file .env -f docker/compose.yml up -d` on a clean VM → the `app` container
  reaches `healthy` (`docker inspect --format '{{.State.Health.Status}}'` — this proves the Node `HEALTHCHECK`
  works with no `curl` in the image) → `curl http://localhost:3000/api/healthz` ok **from the host** →
  browser on `:3000` reaches `/setup`, creates the account, and CRUD survives `docker compose … restart`;
  `${HOST_PORT}` from the repo-root `.env` is honored in the published port mapping (set `HOST_PORT=8080`, prove the app
  answers on `:8080` and nothing is listening on `:3000` — this proves the `HOST_PORT` mapping in `compose.yml` is
  the one under test; `PORT` itself stays pinned to 3000 inside the container (§16)); the container reports
  `NODE_ENV=production` — `docker compose --env-file .env -f docker/compose.yml exec app node -e "console.log(process.env.NODE_ENV)"`
  prints it **with no `NODE_ENV` entry in `.env`**, proving the image/compose set it and the boot guard in §10 is
  actually armed (an unset value would exit non-zero at boot and the container would never reach `healthy`);
  the runtime image adds no build or download tool of its own — proven by asking a container of the image to
  walk `/app` (no tool by name; no `.ts` source of ours, scoped to the payload paths the image ships, since
  third-party packages ship their own TypeScript; nothing under `/app` owned by the app user), **not** by
  `docker history`, whose layer
  *commands* mention `curl` because the base image's ancestors installed it, whether or not the finished image
  keeps it (this sentence corrected while reviewing PR-16: the original read "`docker history` shows no dev deps
  and no `curl`", a check that prints LEAK on a correct image); image runs as uid ≠ 0; boot fails loudly (non-zero) when
  `NOTE_ENCRYPTION_KEY` is missing in production — **and** on that same clean VM, with nothing on it but Docker,
  `docker compose --env-file .env -f docker/compose.yml config` exits non-zero naming the variable without creating a
  single container: that is the form §15 step 2b runs, backed by `${NOTE_ENCRYPTION_KEY:?…}` in the app service. The
  dev/CI form is asserted **in the CI `build` job**, where the repo toolchain exists and never from the runbook: `pnpm
  check:env`, run against four fixture files through `DOTENV_PATH` (§16's loader hook) rather than the runner's own
  environment — defined as `NODE_ENV=production tsx scripts/check-env.ts`, per PR-01's inline-mode rule — exits non-zero
  listing the same missing
  variables **before Docker is contacted**, then exits 0 once `NOTE_ENCRYPTION_KEY` is filled in. Two details make that
  exit-0 reachable and are asserted explicitly: the `.env` under test has **no `NODE_ENV` entry** (the preflight's mode
  comes from its script line, §16) and **no `DATABASE_URL` line** — the runbook's file carries the `POSTGRES_*` trio,
  which is exactly what satisfies the preflight's DSN rule even though the *boot* guard demands a composed
  `DATABASE_URL` in the process (§10). A third assertion pins the negative case: a `.env` with neither form exits
  non-zero naming both options. Two more pin a promise about the *report itself* — added after PR-16's first review
  found the failure paths printing the key they were reporting on: fixtures whose values are pasted into a malformed
  line, into a boolean, and onto a line of their own must still fail and still name the rule, while neither the whole
  value nor its first 20 characters may appear in the log (a prefix grep, because the leak was a truncated one).
  **Operator drills, all executed inside the built image** (this is what proves the runtime layer can actually run them):
  the backup + restore drill from §15, **each numbered step in order** (`pg_dump … | gzip`; `exec -T db createdb -U
  "$POSTGRES_USER" "${POSTGRES_DB}_restore"` — the scratch DB must exist before the pipe can succeed; `gunzip -c
  backup-<date>.sql.gz | docker compose … exec -T db psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore"`; then the app
  started against it with a one-off `DATABASE_URL` override plus an explicit `-p 127.0.0.1:3100:3000` and `run -d`
  (because `run` publishes none of the service's ports), the same `NOTE_ENCRYPTION_KEY`, and a note read back at
  `http://127.0.0.1:3100` — using §15's step-3/step-4 commands **exactly as written**, i.e. plain `docker exec
  restore-drill …` and `docker stop restore-drill`, because `docker compose exec|stop` take a service name and
  `docker compose stop app` would stop the live app mid-drill — every command run **after** `set -a; . ./.env; set +a`,
  because `--env-file` feeds Compose's
  interpolation and never the shell, and run against a `.env` carrying **all three** `POSTGRES_USER`/`POSTGRES_DB`/
  `POSTGRES_PASSWORD` values (§15 step 2): with any of them missing, each `-U "$POSTGRES_USER"` and `${POSTGRES_DB}_restore`
  in the sequence expands to empty and the drill proves nothing; the
  key-rotation drill from §15 — edit `.env` (new key + bumped
  `NOTE_ENCRYPTION_KEY_VERSION` + old key appended to `_PREVIOUS`), `up -d`, then
  `docker compose … exec app node apps/server/dist/scripts/rotate-note-key.js --dry-run` → real run → `--verify` exits 0,
  and a note written *before* the rotation still opens in the browser afterwards; and
  `docker compose … exec app node apps/server/dist/scripts/reset-password.js <username>` lets that user log in again with
  the new password while their folders, notes and settings are untouched. If either script needs something the image
  lacks (pnpm, `tsx`, a `.ts` entry, a published DB port), the fix is to move it under `apps/server/src/scripts/` and
  re-run, not to add dev tooling to stage 2.
- **Out of scope:** Kubernetes manifests, TLS termination (documented only), image registry publishing.

#### PR-19 — Playwright e2e suite + CI e2e job + coverage ratchet
**Branch:** `test/pr-19-e2e` · **Size:** M · **Depends on:** PR-08…PR-18

- **Create:** `apps/web/playwright.config.ts` (webServer: build + start the **compiled** API against a throwaway
  Postgres DB with `NODE_ENV=test node apps/server/dist/index.js` — the inline-mode rule again, §16: a webServer that
  inherits an unset `NODE_ENV` dies on the §10 boot guard before any spec runs,
  `NOTE_ENCRYPTION_KEY` a non-secret test constant supplied as **job env in CI** — exactly as §17 says — and, for local
  runs only, via a gitignored `.env.test` carrying that same throwaway value),
  `e2e/{auth.spec.ts,notes.spec.ts,autosave.spec.ts,folders.spec.ts}`, the **root `test:e2e` script** — the one §17's
  e2e row and the CI `e2e` job invoke; PR-01's root script list deliberately left it out because, like
  `coverage:integration` in PR-04, a script is registered by the PR that creates the config and specs it runs —,
  the CI `e2e` job, and **`e2e/db.ts`** — a
  test-only Postgres reader for scenario 7, written against **`postgres` (postgres.js), the driver §4 already chose and
  PR-04 put in `apps/server`'s dependencies** — not a second `pg` client. Because pnpm does not expose one workspace's
  dependencies to another, PR-19 declares `postgres` as a **devDependency of `apps/web` at the version PR-04 pinned**, so
  the assertion cannot drift onto a different driver and nothing production-facing gains a DB client. Playwright specs run
  in Node, so it connects directly to the same throwaway `notetaker_test` DSN the `webServer` is given (§17); it is
  read-only and is never imported by app code.
- **Scenarios (the MVP acceptance proof):**
  1. first run → `/setup` → owner created → lands on `/app`; sign out → `/login` → sign in.
  2. create folder → create note (assert prefilled `new-file-<ms>.md` and immutable `.md`) → type a heading + a
     toolbar bold → preview shows `<strong>` → **reload the page** → text still there.
  3. rename note → tree shows the new name with `.md`; move note to another folder; tree path updates.
  4. folder with a note → delete without typing name is blocked; typed delete removes both.
  5. autosave: pause 1.5 s after typing — deliberately past the 1200 ms debounce (§11.4) — status pill shows `Saved`; toggle autosave off in settings ⇒ pill shows
     `Unsaved changes` until `Ctrl+S`.
  6. two pages, same note ⇒ conflict UI in the stale page, no silent overwrite.
  7. **at-rest ciphertext — the DB leg of §17's MVP proof, and the only place the README's "encrypted" requirement is
     checked end-to-end:** after scenario 2's body has saved, read that note's row through `e2e/db.ts` and assert the
     typed marker string appears **nowhere** in `content_cipher` (compared as raw bytes, since it is `bytea`), that
     `content_cipher` is non-empty and `content_iv` is exactly 12 bytes (§8), and that `key_version` equals the current
     `NOTE_ENCRYPTION_KEY_VERSION`. Then re-save an unchanged body and assert the ciphertext **changed** — the fresh
     per-write IV (§10) — which is what stops this scenario passing by comparing a stored copy of the plaintext. It
     asserts the accepted opposite too: `notes.name` stays plaintext on purpose (§10's search limitation), so a reader
     of this spec sees both halves of the guarantee instead of one of them silently.
- **Acceptance:** green in CI on `ubuntu-24.04` with the `postgres` service; scenario 7 is the row §19 cites for
  "DB rows are ciphertext" and the §17 proof's DB leg, so it may not be skipped or marked fixme — a run where it does
  not execute is a red build; retries ≤ 1 and the suite is proven
  non-flaky across 3 consecutive runs; the after-PR-19 column of the §14 table is applied to **both** coverage configs —
  the unit thresholds in `pnpm coverage` and the DB-backed ones in the `integration` job's `pnpm coverage:integration`.

#### PR-20 — Documentation & instructions pass (docs-as-code, ADRs, README rewrite)
**Branch:** `docs/pr-20-docs` · **Size:** S · **Depends on:** PR-18 (structure final), PR-19 (verification steps known)

- **Modify:** `README.md` — replace the planning text with: what it is, quick start (Docker one-port), local dev,
  configuration table link, security notes (encryption at rest + key-loss caveat), roadmap link to this plan, and a
  short "what the MVP deliberately does not do" list.
- **Create:** `docs/adr/0001…0005` (one per decision in §4/§5), `docs/ARCHITECTURE.md` (condensed §6–§11 with the
  *as-built* deltas), `docs/API.md` final sweep; **consolidate `AGENTS.md`** — every earlier PR already updated the
  commands it changed (PR-01 seeds that file, per §1's same-PR rule), so this PR reconciles those accumulated edits into
  one coherent list (`pnpm dev/build/lint/typecheck/test/test:integration/coverage`, `make db-up`) plus the layout
  conventions from §7.
- **Acceptance:** every command in the docs was executed successfully in the PR environment; no TODO/placeholder
  left in docs; links between docs resolve (checked with a simple grep for relative links).

---

### Track G — post-MVP backlog (do **not** start before PR-20 merges)

| ID | Task | Why deferred |
| --- | --- | --- |
| PR-21 | Passkeys / WebAuthn (`@simplewebauthn/{server,client}`, `passkey_credentials` table, registration in settings, login page "Use a passkey") | README marks it optional; it is a ceremony + attestation surface, not "a few lines" |
| PR-22 | WYSIWYG mode (TipTap + Markdown schema) behind the same `content_format` column | Requires a lossless MD↔doc round-trip design |
| PR-23 | Trash / undo-delete + note version history UI | Needs soft-delete semantics across folders & notes |
| PR-24 | FS-style folder export/import (ZIP) and optional read-only FS mirror | Answers the README "folder structure" wish without making the FS a second source of truth |
| PR-25 | Three-way merge UI for content conflicts | MVP shows mine/theirs + copy, which is safe |
| PR-26 | Tags, pinning, favorites, drag-and-drop tree, command palette | UX polish |
| PR-27 | Attachments (images) with encrypted blob storage + Markdown image proxy | New storage tier |
| PR-28 | Multi-user: invitations, shared folders, per-item ACLs | MVP is owner-scoped |
| PR-29 | `pg_trgm`/`tsvector` search over a per-note encrypted search index | Only needed past ~5 000 notes |
| PR-30 | Backups automation + restore drill script, metrics (`/metrics`), optional SMTP notifications | Ops hardening |


---

## 13. Dependency graph & parallel execution tracks

```
PR-01 ─┬─ PR-02 ─┬─ PR-04 ─┬─ PR-06 ─┐
       │         │         │         ├─ PR-10 ─┬─ PR-11 ─────────── PR-17
       │         │         └ PR-05 ─┐ │        │
       ├───────── PR-03              │ │        │
       │                             ├─ PR-07 ─┼─ PR-09 ─┬─ PR-12 ─┬─ PR-13 ─ PR-14 ─ PR-16
       │                             │  │      │         │         │       └───────┘
       └─────────────────────────────┘  └────── PR-08 ───┘         └─ PR-15
                     (PR-05 also feeds every route/UI PR as the shared contract)

PR-18 (Docker)  ← everything above merged (can be drafted at PR-12 and rebased)
PR-19 (e2e)     ← PR-18
PR-20 (docs)    ← PR-19
```

**Tracks that can run in parallel**

| Track | PRs | Can start once | Notes |
| --- | --- | --- | --- |
| A — Foundation | 01 → (02, 03) | — | 02 and 03 are independent of each other |
| B — Data & contracts | 04, 05, 06 | 01 / 02 | 05 has zero DB dependency — do it immediately after 01 |
| C — Auth | 07, 08 | 04+05 | 08 UI can be built against contract mocks while 07 lands |
| D — Domain API | 09, 10, 11 | 05+06+07 | strict order 09 → 10 → 11 |
| E — UI | 12, 13, 14, 15, 16, 17 | 08 (+ contract shapes of 09/10) | 12 and 15 overlap: 15 is the small dialog slice, deliberately separable |
| F — Ship | 18, 19, 20 | merge of D+E | sequential |

- **Extra edges the ASCII graph compresses** (the §12 *Depends on* lines are authoritative): PR-15 and PR-17 both
  additionally need **PR-13** (their acceptance ends inside the note editor); PR-14 needs the settings API from
  **PR-09**; PR-16 needs PR-09 + PR-14; **PR-09 needs PR-06** (its `POST /api/notes` seals content and
  `GET /api/notes/:id` decrypts it — the ASCII graph only draws 06 feeding PR-10, so the §12 list is the authority).
- **The dependency graph must stay acyclic through acceptance, not just through file lists.** A PR's acceptance/tests may
  only exercise code that exists when it merges — if a criterion needs a route from a later PR, the criterion is moved to
  that PR (or re-expressed against the layer this PR owns). This is why PR-06 asserts crypto + repository behavior while
  PR-09/PR-10 carry the HTTP-level versions.

**Suggested milestones (review gates):**

- **M0** after PR-03: repo is clonable, CI real, `pnpm dev` serves something.
- **M1** after PR-08: a user can set up an account, log in, land on the `/welcome` placeholder, and log out — on a real DB, in Docker, in CI (the `/app` shell is **not** in M1: PR-08 lands the `/welcome` placeholder here, and PR-12 builds `/app`, which sits between M2 after PR-11 and M3 after PR-17).
- **M2** after PR-11: the whole domain is drivable over the API with tests (no UI needed to prove the product logic).
- **M3** after PR-17: the product is usable end-to-end in a browser.
- **M4** after PR-20: MVP — one `docker compose up`, e2e-proven, documented.

**Merge-conflict hotspots** (call them out in reviews): `apps/server/src/app.ts` (route registration),
root `package.json` scripts, `db/schema.ts`, `components/ui/*`, `styles/globals.css`. Convention: add-only edits
in these files, one route module per PR.

---

## 14. CI design (replaces the placeholder workflow)

`CI.yml` in PR-03 (keep the file name and `name: CI`; `claude-review.yml` consumes `workflow_run: CI`):

```yaml
name: CI                      # ⚠ do not rename — claude-review.yml depends on this exact name
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
permissions: { contents: read }
concurrency: { group: "ci-${{ github.workflow }}-${{ github.ref }}", cancel-in-progress: true }
jobs:
  quality:      # pnpm build:packages && pnpm lint && pnpm typecheck   (~60 s)  — PR-03; the build:packages
                # step starts as a no-op and becomes load-bearing in PR-05 (§14 rule below)
  unit:         # pnpm build:packages && pnpm coverage (unit configs, NO Postgres) + artifact (~75 s) — PR-03
  build:        # pnpm build                           (~2 min)   — PR-03; gains `docker build` in PR-18
  integration:  # services: postgres:16 → pnpm build:packages && pnpm test:integration (~2 min) — added by PR-04;
                # this job also runs `pnpm coverage:integration` (see the coverage rule below) — coverage of everything needing a DB
  e2e:          # build, start app, Playwright chromium (~4 min)  — added by PR-19
```

Rules:

- **Unit and integration files never share a glob.** DB-backed tests are named **`*.int.test.ts`**; the unit configs
  (`apps/server/vitest.config.ts`, `apps/web/vitest.config.ts`, `packages/contracts/vitest.config.ts`) set
  `exclude: ['**/*.int.test.ts']`, and `apps/server/vitest.integration.config.ts` (PR-04) sets
  `include: ['src/**/*.int.test.ts']` and is the only config that reads `DATABASE_URL`. Vitest's default include is
  `**/*.{test,spec}.?(c|m)[jt]s?(x)`, so without that exclusion the repository/route tests PR-04 adds would be collected
  by `pnpm test` and by the Postgres-free `unit` job, and fail on the missing DB. The coverage-scope table below controls
  what is *measured*, not what is *run* — it cannot substitute for this rule.

- Jobs arrive incrementally with the PR that owns the files they run (PR-03 ships `quality`/`unit`/`build`; PR-04 adds
  `integration`; PR-18 adds the `docker build` step; PR-19 adds `e2e`) — see PR-03/PR-04 in §12.
- **`pnpm build:packages` (`pnpm -r --filter './packages/**' build`) runs in every job that typechecks or tests app
  code.** `@note-taker/contracts` declares `exports`/`main`/`types` → `./dist` only (§7) — right for the compiled image's
  runtime import, but a fresh CI checkout has no `dist/`, so `pnpm typecheck` and the Vitest runs in `quality`/`unit`/
  `integration` cannot resolve the specifier from **PR-05 onward**. PR-03 adds the step while it is still a no-op; PR-05
  makes it load-bearing and proves the failure mode is gone (typecheck passes on a clean clone after only
  `pnpm install && pnpm build:packages`). Alternative rejected for the MVP: aliasing `@note-taker/contracts` to `src/` in
  `tsconfig`/Vitest — it would hide whether the published `exports` map actually resolves, which is precisely what PR-05's
  acceptance exists to prove.

- `pnpm install --frozen-lockfile` only; lockfile committed; `cache: pnpm` in `actions/setup-node`.
- Integration/e2e jobs get a throwaway DB: `POSTGRES_PASSWORD: test` service env, `DATABASE_URL` pointing at it —
  always test-only credentials, never real ones (per repo rules, no live secrets in CI files).
- Coverage thresholds live in the Vitest config that produces the number (never in CI flags), so local runs match CI.
  **Every threshold names the job that measures it** — a scope no job executes is not a gate:

| Scope | lines | functions | branches | statements | after PR-19 | enforced by (job · config) |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/contracts` | 90 | 90 | 85 | 90 | 95 | `unit` · `packages/contracts/vitest.config.ts` |
| `apps/server/src/{crypto,domain}` | 80 | 80 | 75 | 80 | 85 | `unit` · `apps/server/vitest.config.ts` |
| `apps/server/src/{services,db,routes}` | 80 | 80 | 75 | 80 | 85 | **`integration`** · `apps/server/vitest.integration.config.ts` (the only job with a Postgres service) |
| `apps/web/src/lib` | 80 | 80 | 75 | 80 | 85 | `unit` · `apps/web/vitest.config.ts` |
| `apps/web/src` overall | 55 | 55 | 50 | 55 | 65 | `unit` · `apps/web/vitest.config.ts` |

- Two coverage commands, each owned by the job that can actually run it: **`pnpm coverage`** (PR-03) runs the *unit*
  configs — no DB service, so its thresholds cover only the pure scopes above — and uploads `coverage-unit/`;
  **`pnpm coverage:integration`** (added by **PR-04**, the PR that creates the integration config) runs
  `vitest.integration.config.ts` with `--coverage` inside the `integration` job's Postgres service and uploads
  `coverage-integration/`. A directory never appears in a config that does not exercise it, and the `routes`/`services`/
  `db` numbers come only from the integration run.
- Thresholds only ever ratchet upward; a PR that wants to lower one needs a written justification in its description.
- The `docker build` **step** inside the `build` job never pushes an image (no registry configured in the MVP).
- Flaky policy: `retries: 1` for e2e only; a test that fails on re-run gets an immediate follow-up issue/PR.
- The two `apps/web` rows are armed when the web scope first has tests to measure: **PR-05** turns on
  `apps/web/src/lib` (mocked-`fetch` tests for `lib/api.ts`) and drops PR-01's `passWithNoTests: true`; **PR-08** turns
  on the overall `apps/web/src` row with its component tests. Before PR-05 the web config passes with zero files and
  declares no thresholds, so `pnpm coverage` cannot fail on an empty scope. Every other row is armed by the PR named in
  its `enforced by` cell.

---

## 15. Docker / self-hosting runbook

**Dev** (PR-02): `make db-up` → Postgres 16 on `localhost:5432` in Docker; the app runs on the host with
`pnpm dev` (`tsx watch` API on `:3000`, Vite on `:5173` proxying `/api`). No key setup is needed in dev:
`.env.example` ships `NODE_ENV=development` plus the dev `POSTGRES_*`/`HOST_PORT` defaults and **no** `DATABASE_URL`
line (the DSN is derived from `POSTGRES_*` by `env.ts`, §16), and every compose-facing
make target depends on a `bootstrap-env` step (`test -f .env || cp .env.example .env`) before it can pass `--env-file .env`.
The `NODE_ENV` line in that file is what Compose interpolation reads, and what `scripts/check-env.ts` validates when it
lints the file as data (§16); a running Node process gets its mode from the script that starts it (`NODE_ENV=development
tsx watch src/index.ts` in `apps/server`, PR-01) or from the container's `environment:` block, never from the file (§16),
and that process value is what selects the generated-and-persisted dev key path described in §10 — with `NODE_ENV` unset
the boot guard fails here too. The other values reach a host process through PR-01's `loadDevEnvFile()` (§16): Compose's
`--env-file .env` feeds Compose's *own* interpolation only, so without that loader `pnpm dev`, `pnpm db:migrate`,
`pnpm db:seed` and `pnpm test:integration` on the host would ignore the very file `bootstrap-env` has just created.

**Production** (PR-18):

```bash
# 1. generate config in the REPO ROOT (this is the file the app and compose both read)
printf 'NOTE_ENCRYPTION_KEY=%s\n' "$(docker run --rm node:22-slim node -e \
  'console.log(require("crypto").randomBytes(32).toString("base64"))')" > .env
#    NODE_ENV needs no entry here: the production image bakes ENV NODE_ENV=production into stage 2 and compose
#    repeats it in the app service's environment block (§16 explains who sets what).
# 2. fill in POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD (+ optionally HOST_PORT) in .env. All three POSTGRES_*
#    values are REQUIRED in this file: `notetaker` in §16 is only Compose `${VAR:-notetaker}` interpolation, so an
#    operator who omits them gets a working container but an EMPTY `$POSTGRES_USER`/`$POSTGRES_DB` in the shell, and
#    every command in the runbook below silently degrades to `pg_dump -U "" ""` and `createdb … "_restore"`.
#    POSTGRES_PASSWORD must be URL-safe — generate it with `openssl rand -hex 32`. The app's DSN is composed from
#    these values **raw** (the `app` service's `environment:` block below; `databaseUrl()` on the host — §16), and
#    nothing percent-encodes on the way, so `@`, `:`, `/`, `+`, `%`, `?` or `#` in a password silently corrupt the URL.
#    DATABASE_URL needs no entry — the app service's environment: block derives it from these same values and takes
#    precedence over env_file:. On the host the same derivation happens in env.ts's databaseUrl() when the variable
#    is unset (§16); writing DATABASE_URL into this file freezes it against later POSTGRES_* edits.
# 2b. preflight the file with Docker alone. §3 keeps scripts/ dev/CI-only, and this host may have no Node at all
#     (step 1 uses `docker run node:22-slim` for exactly that reason), so the check is Compose's own: the app
#     service demands the key with ${NOTE_ENCRYPTION_KEY:?…} (§15's compose note), so a missing key fails here,
#     before any container is created, naming the variable. It resolves the whole file — interpolation, the
#     POSTGRES_* trio, quoting — but NOT the semantic rules (DSN shape, TTL, cookie flags); those belong to the
#     boot guard, and if the container below ever fails to come up healthy, its operator-facing text is one
#     `docker compose --env-file .env -f docker/compose.yml logs app` away.
docker compose --env-file .env -f docker/compose.yml config >/dev/null
#    Then — always from the repo root, and always with BOTH flags (see the note below):
docker compose --env-file .env -f docker/compose.yml up -d     # publishes ONLY ${HOST_PORT:-3000}
docker compose --env-file .env -f docker/compose.yml ps        # app reported healthy
# 3. open http://<host>:<HOST_PORT> (3000 by default)  → /setup → create the first owner
```

> **Why the flags are mandatory.** Compose resolves its *project directory* from the compose file's location, so
> with `-f docker/compose.yml` it auto-loads `.env` from `docker/` — **not** from the repo root. Without
> `--env-file .env`, `${HOST_PORT:-3000}`, `POSTGRES_PASSWORD` and the `DATABASE_URL` handed to the app silently fall
> back to defaults/empty. Either always pass `--env-file .env` (recommended, shown above), or keep the file at
> `docker/.env` and say so in `docs/DEPLOY.md`. `docs/DEPLOY.md` and the `Makefile` must use the identical
> invocation; `make` targets wrap it so operators cannot get it wrong. `docker/compose.yml` additionally declares
> `env_file: ../.env` on the `app` service so the container's own environment does not depend on the shell. The `app`
> service `environment:` block sets `DATABASE_URL` to
> `postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB`, so the DSN is derived from the same `POSTGRES_*`
> values the `db` container initializes with — host is the service name `db` (never `localhost`, which only exists on a
> developer machine). The interpolation is **raw** — nothing URL-encodes the three values as they are composed — which is
> why step 2 requires a URL-safe (hex) `POSTGRES_PASSWORD`: Compose cannot percent-encode inside a URL, and once the
> string reaches the container the app cannot repair a password that ate the DSN's delimiters.
> `NODE_ENV=production` is set in the same block, and so is
> `NOTE_ENCRYPTION_KEY: ${NOTE_ENCRYPTION_KEY:?set NOTE_ENCRYPTION_KEY in the repo-root .env}` — required, no default,
> which is what turns §15 step 2b's `docker compose config` into a real preflight on a host with no Node: Compose
> refuses to resolve the file instead of handing the container an empty key. (The mounted-key-file variant below is
> already an edit to this file — volume plus `NOTE_ENCRYPTION_KEY_FILE` — and removing this `:?` line is part of that
> edit, because an either/or is not something Compose interpolation can express.) So the three `POSTGRES_*` values
> the operator writes
> into `.env` (plus `NOTE_ENCRYPTION_KEY` and, optionally, `HOST_PORT`) are the entire compose-level contract; §16
> lists who sets what — `NODE_ENV` is **not** one of them, the image and the `app` service set it.
> `POSTGRES_PORT` is **dev-only** — it appears solely in `docker/compose.dev.yml`, never in the prod file.

- Single published port: `app.ports: ["${HOST_PORT:-3000}:3000"]` (set `HOST_PORT=8080` in the repo-root `.env` to move
  the host side); `db` has **no** published port.
- Volumes: `pgdata` (Postgres). Optionally mount a key file (`secrets/note-key.txt`) instead of an env var —
  the compiled `crypto/keys.ts` (PR-06) resolves `NOTE_ENCRYPTION_KEY_FILE` at boot, so the file can be mounted instead of pasted into the env.
- Updates: `git pull && docker compose --env-file .env -f docker/compose.yml build && docker compose --env-file .env
  -f docker/compose.yml up -d` (the Node bootstrap runs migrations before `listen()` — the entrypoint is only `exec node …`;
  migrations must be backward-compatible within one minor release — documented rule).
- **Operator shell convention (applies to every command in this runbook):** `set -a; . ./.env; set +a` **first**.
  `--env-file .env` feeds Compose's *own* variable interpolation only — it never populates the shell, so a bare
  `$POSTGRES_PASSWORD` typed at the prompt expands to empty and the DSN silently becomes `postgres://notetaker:@db:5432/…`
  (auth failure). And **never hardcode `notetaker`** in these commands: `POSTGRES_USER`/`POSTGRES_DB` are configurable
  (§16), so use `"$POSTGRES_USER"` / `"$POSTGRES_DB"`. That only works because the quick start above makes all three
  `POSTGRES_*` values explicit in `.env` — Compose's `${VAR:-notetaker}` default exists **only** inside Compose's
  interpolation and is invisible to a sourced shell, so an omitted variable would expand to `""` here rather than to
  `notetaker`. If you want a second belt, run `: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"`
  after sourcing: it fails loudly instead of letting `pg_dump -U "" ""` look like a success.
- Backups: `docker compose --env-file .env -f docker/compose.yml exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "backup-$(date +%F).sql.gz"` (`-T` is mandatory: `docker compose exec` allocates a TTY by default, which CRLF-translates the dump and corrupts it)
  **plus the encryption key** (`.env`, or the mounted key file, or `.dev/note-key` in dev). The restore and the
  **key-rotation procedure** are documented in `docs/DEPLOY.md`; the rotation runbook is spelled out below.
- **Restore drill (PR-18 acceptance, and the procedure `docs/DEPLOY.md` must contain).** After the shell convention
  above, four ordered steps. The scratch database must **exist before anything is piped into it** — `psql -d …_restore`
  alone dies with `database "…_restore" does not exist`:
  1. `docker compose --env-file .env -f docker/compose.yml exec -T db createdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"`
     — same `db` container, never over the live `$POSTGRES_DB`. Do **not** try the "rename `POSTGRES_DB`" route: the
     postgres image reads `POSTGRES_DB` only while initializing an **empty** data directory, so it does nothing to an
     existing `pgdata` volume;
  2. `gunzip -c backup-<date>.sql.gz | docker compose --env-file .env -f docker/compose.yml exec -T db psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" -v ON_ERROR_STOP=1`;
  3. start the **app** against the scratch DB. `compose.yml` derives `DATABASE_URL` from `$POSTGRES_DB`, so the drill has
     to override it — and `docker compose run` **publishes none of the service's `ports:`** by default (that is how it
     avoids colliding with the live app), so the drill must map a port explicitly with `-p`, and must run **detached**
     (or in a second terminal) because step 4 needs the process still alive:
     `docker compose --env-file .env -f docker/compose.yml run -d --rm --name restore-drill -p 127.0.0.1:3100:3000 -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/${POSTGRES_DB}_restore" app`
     — with the **same** `NOTE_ENCRYPTION_KEY`, or every note decrypts to garbage and the drill proves nothing. `run -e`
     overrides the service's `environment:` mapping; confirm that with
     `docker exec restore-drill printenv DATABASE_URL` before trusting a green run — note the **plain `docker`** CLI here
     and in step 4: `docker compose exec` and `docker compose stop` take a **service** name, not a container name, so
     `docker compose exec restore-drill …` fails, and `docker compose stop app` would take the **live** app down
     mid-drill;
  4. open `http://127.0.0.1:3100`, log in, and read a note back; then `docker stop restore-drill` — plain `docker`, per
     the step-3 note, and `--rm` then removes that one-off container; then
     `docker compose --env-file .env -f docker/compose.yml exec -T db dropdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore"`.
  The drill must consume exactly the artifact the backup step produces, `gzip` included — an ungzipped or TTY-corrupted
  dump failing at step 2 is the point of the drill.


- **Key rotation (the operator procedure `docs/DEPLOY.md` must contain, PR-18; the script itself is PR-06).** The script
  is compiled into the image, so it runs where the DB and the keyring already are — no pnpm, no `tsx`, no second DB
  port:
  1. back up first — the **Backups** bullet above, not the restore-drill list below it — a rotation without a fresh backup is unsupported;
  2. edit the repo-root `.env` **by hand** (the script cannot change a running container's environment): append the old
     key to `NOTE_ENCRYPTION_KEY_PREVIOUS` as `{"<old version>": "<old base64>"}`, set the new `NOTE_ENCRYPTION_KEY`,
     bump `NOTE_ENCRYPTION_KEY_VERSION` to `<old>+1`. **Write that value single-quoted** —
     `NOTE_ENCRYPTION_KEY_PREVIOUS='{"1": "sGx/…="}'`: Compose strips one layer of surrounding quotes when it loads the
     file through `env_file:`, while the shell convention above *sources* the same file, where a bare `{…}` containing a
     space is a syntax error that breaks `set -a; . ./.env; set +a` for every later command in this runbook. The JSON must
     therefore contain no single quotes of its own;
  3. `docker compose --env-file .env -f docker/compose.yml up -d` so the app process picks the new keyring up (old rows
     still decrypt through `_PREVIOUS` from this moment on);
  4. `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/rotate-note-key.js --dry-run`
     (reports the per-`key_version` row counts it is about to rewrite), then the same command without `--dry-run`;
     The app is live during this step and autosave keeps writing: the script locks each batch's rows
     (`SELECT … FOR UPDATE`) and writes conditionally (`WHERE id=$1 AND version=$2 AND key_version=$old`), so a save
     landing mid-rotation is never overwritten — a row it cannot write is left for the next pass (PR-06);
  5. `… rotate-note-key.js --verify` ⇒ exit 0 means every row's `key_version` is the current one and every row decrypts;
  6. only once `--verify` is green may the old entry be removed from `_PREVIOUS` on the next edit of `.env`.
- **Password recovery:** `docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/reset-password.js <username>`
  (PR-07). It changes the hash and that user's sessions and nothing else. **Never** delete a `users` row to "reset" an
  account: the `user_id` FKs cascade over sessions/folders/notes/settings and `POST /api/auth/setup` stays blocked while
  an owner row exists (the guard is the owner, not the table: §9.2 #3).

---

## 16. Configuration reference

`.env.example` (PR-01, extended by PR-02 with the dev DB vars, then PR-06/PR-18). Values shown are safe non-secret defaults.

| Var | Default | Prod required | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | **none — required**: `development`, `test`, or `production` | ✔ `production` | selects the invariant set enforced by the compiled `env.ts` at boot; an unset value fails in every environment (§10). Nobody hand-sets it in production: the image bakes `ENV NODE_ENV=production` into stage 2 and `compose.yml` repeats it in the `app` `environment:` block. Locally and in CI the value comes from the **script line** (`NODE_ENV=development tsx …`, `NODE_ENV=development drizzle-kit …`, `NODE_ENV=test vitest …` — PR-01's rule), never from the shell or from reading the file; `.env.example`'s `NODE_ENV=development` is the value Compose interpolates and `check-env.ts` lints. CI therefore needs no `NODE_ENV` of its own for `pnpm test:integration` (§14) |
| `HOST` | `0.0.0.0` | — | bind address |
| `PORT` | `3000` | — | port the container listens on; `compose.yml` pins it to 3000 so `EXPOSE`/`HEALTHCHECK` stay valid — use `HOST_PORT` to publish elsewhere |
| `HOST_PORT` | `3000` | — | host side of the single published mapping (`"${HOST_PORT:-3000}:3000"`) — the operator-facing port knob |
| `POSTGRES_USER` | `notetaker` | ✔ **in `.env` whenever compose is used** | role + owner created by the `db` service of `docker/compose.yml` (prod compose publishes no port). The §15 runbook's shell commands read this variable, so it must be written into `.env` — Compose's `${POSTGRES_USER:-notetaker}` fallback covers Compose only (§15) |
| `POSTGRES_PASSWORD` | `notetaker` | ✔ for the compose stack | the **only** secret the `db` container needs; an explicit `DATABASE_URL` must embed the same value, and with it unset `databaseUrl()` embeds it for you (§16). Both compositions embed the value **raw**, so it must be URL-safe — `[A-Za-z0-9]+` in practice, generated as hex (`openssl rand -hex 32`) per the §15 quick start; `databaseUrl()` rejects a value containing `@ : / + % ? #` with a readable error naming the variable rather than emitting a broken DSN |
| `POSTGRES_DB` | `notetaker` | ✔ **in `.env` whenever compose is used** | database created by the `db` image's first init; also interpolated into the app's `DATABASE_URL` by `compose.yml` and used as the base for the §15 restore drill's `<db>_restore` — so it must be written in `.env` like `POSTGRES_USER`, not left to Compose's default |
| `POSTGRES_PORT` | `5432` | — | host port published for the **dev** compose `db` only (`docker/compose.dev.yml`); the prod `db` publishes nothing |
| `DATABASE_URL` | **unset ⇒ derived** as `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:<POSTGRES_PORT>/<POSTGRES_DB>` (`notetaker`/`notetaker`/`5432`/`notetaker` in dev — see the DSN-resolution bullet below); **set ⇒ used verbatim** | ✔ **required in `production`**, optional elsewhere | Postgres DSN. In the container stack you do **not** set this: `docker/compose.yml` derives it from the `POSTGRES_*` values in the `app` service `environment:` block (which takes precedence over `env_file:`), with the host part as the service name `db` — never `localhost`, which only exists on a developer machine. A hand-written `DATABASE_URL` in the repo-root `.env` is overridden by that block and has no effect inside the stack (§15 step 2). `.env.example` deliberately ships **no** `DATABASE_URL` line: leaving it unset is what makes one `POSTGRES_PORT`/`POSTGRES_PASSWORD` edit move both the dev container and every host process (PR-04's acceptance pins that), whereas adding the line freezes the DSN, because `process.loadEnvFile` expands nothing. The one place a runbook must set it explicitly is the §15 restore drill, which uses `run -e DATABASE_URL=…` to point the app at the scratch DB |
| `DB_POOL_MAX` | `10` | — | postgres.js pool size |
| `SESSION_TTL_DAYS` | `30` | — | session cookie + DB expiry |
| `SECURE_COOKIES` | `false` (dev) | ✔ `true` behind TLS | `Secure` cookie flag |
| `TRUST_PROXY` | `false` | ✔ if behind a proxy | accurate client IPs for rate limiting (`X-Forwarded-For`); since PR-07 also the authority the CSRF `Origin`/`Sec-Fetch-Site` check compares against, taken from `X-Forwarded-Host` + `X-Forwarded-Proto` (last value wins). A proxy that rewrites `Host` and sends neither header turns every same-origin browser mutation into a `403` |
| `ALLOW_REGISTRATION` | `false` | — | when true, `POST /api/auth/register` (PR-07) opens self-service sign-up; when false, accounts come only from `POST /api/users` (owner only) |
| `NOTE_ENCRYPTION_KEY` | — | ✔ (32 bytes base64) | current AES-256 key |
| `NOTE_ENCRYPTION_KEY_FILE` | — | alternative to `NOTE_ENCRYPTION_KEY` | key read from a mounted file by `crypto/keys.ts` (PR-06) at boot |
| `NOTE_ENCRYPTION_KEY_PREVIOUS` | — | only during rotation | JSON map `{"1": "<base64>"}` of **older** keys, kept decrypt-only for as long as any row carries that `key_version`. Written **single-quoted** in `.env` (`='{"1": "…"}'`): Compose strips the surrounding quotes for the container, while the runbook's `set -a; . ./.env; set +a` sources the same file, where unquoted JSON is a shell syntax error (§15, rotation step 2) |
| `NOTE_ENCRYPTION_KEY_VERSION` | `1` | ✔ set alongside the key | the integer tag stamped into `notes.key_version` for the **current** key. Explicit, never derived from `_PREVIOUS`; the operator bumps it by hand in `.env` (§15, rotation step 2 — not the step-2 of the quick-start list, which is the `POSTGRES_*` entry) and `apps/server/src/scripts/rotate-note-key.ts` rewrites every row's `key_version` to that value (§10, PR-06) |
| `LOGIN_RATE_LIMIT_MAX` | `10` | — | failures per 15 min per user+IP |
| `MAX_NOTE_BYTES` | `1048576` | — | request body / note size cap |
| `LOG_LEVEL` | `info` | — | pino level |
| `DOTENV_PATH` | `<repo root>/.env` | — | override for the file `env.ts`'s `loadDevEnvFile()` reads (dev/test only) **and** for `scripts/check-env.ts` (PR-18), which runs in production mode and reads it as data; tests point it at a fixture (§16) |
| `APP_NAME` | `Note Taker` | — | title shown in the SPA |

`env.ts` (Zod-parsed) fails fast with a readable list of problems; `scripts/check-env.ts` adds the cross-field
prod rules. **Never** commit a real `.env`; `.gitignore` covers `.env*` except `.env.example`.

**How the repo-root `.env` reaches a process (PR-01 owns this; §15 explains the Compose side).** Compose's
`--env-file .env` feeds Compose's *own* interpolation only (§15) and `env.ts` reading `process.env` is not a loader, so
the plan states the mechanism instead of leaving it implicit:

- `apps/server/src/env.ts` exports **`loadDevEnvFile()`**, called at the top of every host-run entry point that *boots*
  something — `index.ts` (dev server), the Vitest **setup file of `vitest.integration.config.ts`** (PR-04),
  `drizzle.config.ts` (PR-04, because drizzle-kit never imports `env.ts` on its own) and `scripts/seed-demo.ts` (PR-09).
  It does nothing unless the **process** `NODE_ENV` is `development` or `test`; then it resolves the file as
  `process.env.DOTENV_PATH ?? <repo root>/.env`, the repo root being the first directory at or above
  `import.meta.dirname` that contains `pnpm-workspace.yaml` (a fixed `../../.env` is wrong: from
  `apps/server/src/env.ts` under `tsx` that lands on `apps/.env`, and the depth changes again once the file is
  compiled to `apps/server/dist/…`). It calls `process.loadEnvFile(path)` inside a `try` that swallows only `ENOENT`
  (a missing file is normal — PR-01 boots from a bare clone — while any other read failure must fail loudly; Node 22's
  parser is lenient about file *content*, so a *malformed* file is not detectable as such and an unreadable path is the
  loud case), and both behaviors are asserted in PR-01's unit tests. Node 22 built-in, so no `dotenv` dependency; `node
  --env-file-if-exists=…` exists on this Node version too, but it must be repeated in every workspace script, cannot
  express the `NODE_ENV` gate, and does not run inside `drizzle-kit` or Vitest, so the rule lives in one exported
  function instead.
- **`scripts/check-env.ts` (PR-18) is the deliberate exception — a linter, not a boot path.** It reads
  `process.env.DOTENV_PATH ?? <repo root>/.env` **as text with its own parser** and validates it against the rules of the
  mode its own script line declares (`check:env` = `NODE_ENV=production tsx scripts/check-env.ts`). Routing it through the
  loader would be wrong twice over: the loader is a no-op in `production` by design, and a preflight has to see the
  operator's file whether or not the shell already exports those keys. Its one rule that cannot be copied verbatim from the
  boot guard is the DSN (§10): the guard fails an unset **process** `DATABASE_URL`, which is right because Compose has
  already composed it, while the linter sees only the file, where the documented prod `.env` carries the `POSTGRES_*` trio
  and deliberately no DSN (§15). So the linter accepts **either** form, fails only on a file that has neither, and warns
  when both are present and disagree — otherwise the runbook's own `.env` could never pass its own preflight.
- **The file can never supply `NODE_ENV`, so every script that reads env declares its mode inline.** The gate reads the
  value already in the **process** environment, so a stray `.env` cannot turn a production boot into a development one,
  and `env.ts`'s "`NODE_ENV` is required, there is no default" rule (§10, PR-01's acceptance) survives the loader.
  Consequence — the reason PR-01 states it as a contract the later PRs implement: each host entry point puts the
  assignment in its own script line: `dev` (PR-01), `db:generate`/`db:migrate` and
  `test:integration`/`coverage:integration` (PR-04), `db:seed` (PR-09), `check:env` (PR-18). Running one of them with no
  mode in the environment is not a mode, it is §10's missing-`NODE_ENV` failure, and PR-04 asserts that pair.
  `.env.example`'s `NODE_ENV=development` line exists for Compose interpolation and as a value
  `scripts/check-env.ts` lints **as data**; it never rescues a host process started outside `pnpm dev`.

- **Precedence: the environment beats the file.** `process.loadEnvFile` does not overwrite already-set keys (verified
  on Node 22.22), so CI's explicit `DATABASE_URL`, the container environment Compose injects, and a one-off
  `DATABASE_URL=… pnpm db:migrate` always win over `.env`. The file only fills gaps.
- **The DSN is resolved by one exported function, `env.ts`'s `databaseUrl()`, not read ad hoc.** Resolution order:
  1. **`DATABASE_URL` is set** (process env or `.env`) → use that string **verbatim**. `process.loadEnvFile` performs no
     `${VAR}` expansion (verified on Node 22.22), so a hand-written DSN is a literal: it does **not** track a later
     `POSTGRES_PORT`/`POSTGRES_PASSWORD` edit, and the two must be changed together if the operator edits one.
  2. **Unset and `NODE_ENV` is `development`/`test`** → derive it:
     `postgres://${POSTGRES_USER ?? 'notetaker'}:${POSTGRES_PASSWORD ?? 'notetaker'}@localhost:${POSTGRES_PORT ?? 5432}/${POSTGRES_DB ?? 'notetaker'}`
     (the host is literally `localhost`, because this branch only runs outside containers; inside the stack Compose
     supplies its own DSN with host `db`, §15). The composition embeds the three values **raw** — no layer percent-encodes
     them afterwards — so `databaseUrl()` first validates that `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` are
     URL-safe (`[A-Za-z0-9]+` in practice; a value containing `@ : / + % ? #` fails with a readable error naming the
     variable instead of producing a mangled DSN), `check-env.ts` (PR-18) applies the same check to the trio in the file,
     and the §15 quick start's hex-password rule is what keeps every composition path (Compose, host, restore drill)
     consistent. This is what makes
     a bare clone usable before `.env` exists **and** what makes PR-04's acceptance (§12) meaningful — flipping
     `POSTGRES_PORT` moves both the dev container's published port and every host process, because the DSN is derived
     from the same variable. `drizzle.config.ts`, the integration Vitest setup and `scripts/seed-demo.ts` call this same
     function after `loadDevEnvFile()`; none of them builds its own DSN.
  3. **Unset and `NODE_ENV=production`** → no derivation and no default: the boot fails naming `DATABASE_URL`. The
     `check-env.ts` preflight (PR-18) deliberately does **not** mirror that literal — it reads the file, where the prod
     runbook writes the `POSTGRES_*` trio instead of a DSN, so a complete trio satisfies its rule (§10). In the Compose
     stack the value is never missing, because the
     `app` service's `environment:` block sets it from the same `POSTGRES_*` values with host `db` (§15). A production
     process pointed at `localhost` is therefore always an explicit choice, never an accident.
  In `development`/`test`, when an explicit `DATABASE_URL` disagrees with the `POSTGRES_*` values in the same file
  (different port or db), `env.ts` logs one warning naming both, so the literal-vs-derived trap is visible instead of
  silently connecting to the wrong database.
- The consequence PR-02/PR-04 acceptance asserts: with **no** `DATABASE_URL` in the file, editing `POSTGRES_PORT` or
  `POSTGRES_PASSWORD` in the repo-root `.env` changes **both** what the dev `db` container publishes and what the host
  API, `pnpm db:migrate` and the integration tests connect to, because both sides read the same variables through
  `loadDevEnvFile()` + `databaseUrl()`. With a literal `DATABASE_URL` present, only the container follows the `POSTGRES_*`
  edit, and the DSN line has to be edited in the same breath — which is why `.env.example` ships `POSTGRES_*` and
  `HOST_PORT` but **no** `DATABASE_URL` line (§15, PR-02).

---

## 17. Testing & verification strategy

| Layer | Tooling | Command | Lives in | Owner PR |
| --- | --- | --- | --- | --- |
| Pure unit (name rules, markdown transforms, autosave machine, crypto, tree selectors, env parsing) | Vitest + `@testing-library/react` (components) | `pnpm test` / `pnpm coverage` | `*.test.ts(x)` next to sources, **never** a `*.int.test.ts` file (the §14 exclusion) | every PR |
| API integration (real Postgres, `app.inject()` — no port binding) | Vitest + Drizzle | `pnpm test:integration` (and `pnpm coverage:integration`, which produces the DB-backed coverage numbers the §14 table enforces in the `integration` job) | `apps/server/src/{routes,db,services}/**/*.int.test.ts` — the suffix is the split rule, §14 | PR-04 onward |
| Contract tests | Schemas exercised from both apps; a route that drifts from `contracts` fails typecheck | `pnpm typecheck` | `packages/contracts` | PR-05 |
| e2e (browser, real app, real DB, encryption on) | Playwright chromium | `pnpm test:e2e` | `apps/web/e2e/*.spec.ts` | PR-19 |
| Manual acceptance (only for things automation can see poorly: feel of autosave, preview fidelity) | checklist below | — | PR body screenshots/video | PR-13, PR-14 |

**The MVP proof (must be demonstrated, PR-19):** open the app → set up → create nested folders → create a note
(auto-named) → write Markdown using the toolbar → see the preview → close the tab mid-edit → reopen → the text is
there → the DB contains only ciphertext for that note → rename/move/delete behave → logout/login restores state.
The middle step is not a screenshot: it is PR-19's **scenario 7**, which reads the row over a test-only postgres.js
connection, and it is the only end-to-end evidence for the README's "securely / 2-way encrypted" requirement (§19).

Determinism rules: `test/helpers/db.ts` truncates in dependency-safe order between tests; time-dependent tests use
`vi.useFakeTimers()`; e2e uses a dedicated `notetaker_test` DB and a fixed test `NOTE_ENCRYPTION_KEY` supplied by
the CI job (a throwaway value, not a real key); no test touches the network.

---

## 18. Definition of Done for the MVP

The MVP is done when **all** of these are true on `main`:

1. `docker compose --env-file .env -f docker/compose.yml up -d` from a clean VM serves the app on **one** port and
   the `app` container reaches `healthy`; the browser flow `/setup → /app → CRUD notes` works; data survives restart.
2. Username+password auth with hashed passwords, DB sessions, logout, change-password, rate-limited login, CSRF
   protection, and per-user data isolation verified by tests.
3. Folder tree: create / rename / nest / move (cycle-safe) / cascade delete — with typed confirmation for deletes.
4. Notes: create with a **name prompt prefilled `new-file-<msepoch>.md`** and a **non-editable `.md` suffix**,
   rename, move, delete; names unique per folder.
5. Markdown editor with toolbar + live preview (split/write/preview), GFM rendering, sanitized output.
6. **Autosave on by default**, off-able per user, visible status, conflict-safe across tabs, nothing lost on reload.
7. Note bodies encrypted at rest (AES-256-GCM) with generation + rotation scripts and a boot guard in production.
8. CI: lint + typecheck + unit tests with coverage thresholds + Postgres integration tests + Docker build +
   Playwright e2e all green; `claude-review.yml` still triggers on `CI`.
9. Docs: rewritten `README.md`, `docs/{ARCHITECTURE,API,DATA-MODEL,DEPLOY}.md`, five ADRs, and `AGENTS.md`
   reflecting real commands and layout.
10. Post-MVP backlog (§12 Track G) recorded and linked from the README roadmap.

---

## 19. Requirements traceability matrix

| README requirement (current README line) | Realized by | Verified in |
| --- | --- | --- |
| "simple, lightweight web app … easily self hosted and assigned to a port" (L10) | PR-18 (single image, one port), PR-01 (build), `docs/DEPLOY.md` | PR-18 acceptance + PR-19 e2e against the built app |
| "Docker" (L11) | PR-02 (dev), PR-18 (prod image + compose) | CI `build` job + PR-18 manual drill |
| "sensible, modern framework, proper standard structures and packages" (L13) | §5 stack, PR-01 scaffold, §7 repo map | PR-01 acceptance + PR-20 docs |
| "nodejs/react/tailwind/tanstack/zod/psql+drizzle" stack preference (L14) | §5 (adopted verbatim, plus Fastify + CodeMirror) | dependency manifest in PR-01/04/05 |
| "full CI suite: lint+typings+unit tests with coverage bare minimum" (L16-17) | PR-03 (§14) | CI red/green proof in PR-03 |
| "very basic authentication, username+password" (L19) | PR-07 (core) + PR-08 (UI) | PR-07 integration tests, PR-19 e2e #1 |
| "passkey as alternative … not needed for mvp" (L20) | deferred → PR-21, schema leaves room via `role`/credential tables | backlog recorded |
| "Manage markdown notes, saving them in a folder structure" (L22) | PR-04 (`folders`/`notes`), PR-09 (API), PR-12 (tree UI) | PR-09 + PR-19 e2e #2/#3/#4 |
| "Backend stores saved notes efficiently & securely. 2 way encrypted?" (L23) | PR-06 envelope crypto, §10 | PR-06 unit/integration tests + **PR-19 scenario 7** (row read through `e2e/db.ts`: no plaintext in `content_cipher`, 12-byte IV, current `key_version`, ciphertext changes on re-seal) |
| "Folders and notes persistence: Raw file system? or database?" (L24) | decided: Postgres — ADR-0001, PR-04 | PR-04 integration tests |
| "Folders and filenames can be renamed" (L25) | PR-09 (`PATCH /api/folders/:id`, `PATCH /api/notes/:id`) + PR-12/PR-15 dialogs | PR-09 tests, e2e #3 |
| "Auto-save can be enabled (default on)" (L26) | PR-14 (engine, default on), PR-09 (settings API), PR-16 (setting UI) | PR-14 unit tests, e2e #5 |
| "File names auto generated as `new-file-<msepoch>.md` … ask for file name … extension not editable" (L27) | `contracts/names.ts` (PR-05), `NewNoteDialog` (PR-15) | PR-05 + PR-15 tests, e2e #2 |
| "Provide a text editor UI producing markdown" (L29) | PR-13 (editor + preview) | PR-13 tests, e2e #2 |
| "'word' style with toolbar **OR** raw markdown + preview" (L30-32) | raw Markdown + toolbar + preview — ADR-0003, PR-13 | PR-13 transform tests; WYSIWYG deferred to PR-22 |

---

## 20. Risks & mitigations

| # | Risk | Impact | Mitigation (owner PR) |
| --- | --- | --- | --- |
| R1 | **Losing `NOTE_ENCRYPTION_KEY` = unrecoverable notes** | Critical, user data | Key backup + restore drill in `docs/DEPLOY.md`; fingerprint logging; the compiled `env.ts` boot guard, which is the one that actually runs at boot, plus `check-env.ts` as a dev/CI preflight (PR-06, PR-18) |
| R2 | Autosave silently overwrites in a second tab | Lost writing | `version` optimistic concurrency + conflict UI (PR-10, PR-14) — never last-write-wins |
| R3 | Browser crash between keystrokes and the debounce window | Small text loss | Draft mirror in `localStorage`, restore prompt, flush on `pagehide` (PR-14) |
| R4 | Cascade folder delete nukes many notes accidentally | Data loss | API requires `cascade=true`; UI requires typing the folder name; hard delete logged (PR-09, PR-12) |
| R5 | In-process search degrades as notes grow | Sluggish UX | 500-candidate cap + recency ordering; documented `pg_trgm`/`tsvector` path (PR-11, PR-29) |
| R6 | Breaking the placeholder `CI.yml` name silently disables Claude reviews | Silent tooling loss | PR-03 keeps `name: CI`; acceptance step verifies the `workflow_run` still fires |
| R7 | Tailwind v4 / CodeMirror API churn | Rework | Pinned versions, thin wrappers (`components/ui`, `lib/markdown.ts`), textarea fallback documented in PR-13 |
| R8 | `pnpm` lockfile not committed → `--frozen-lockfile` fails in CI | Red CI forever | PR-01 commits `pnpm-lock.yaml`; PR-03 uses `--frozen-lockfile` |
| R9 | Two sources of truth if someone adds FS writes later | Corrupt tree | ADR-0001 + `AGENTS.md` rule (PR-20); FS export only as read-only (PR-24) |
| R10 | Session fixation / cookie leak on plain HTTP | Account takeover | Rotation on login, `Secure` behind TLS enforced by the compiled `env.ts`, `SameSite=Lax` + CSRF token (PR-07, PR-18) |
| R11 | Scope creep (passkeys, WYSIWYG, trash) delaying MVP | Ship risk | §3.2 explicit non-goals + Track G frozen until PR-20 |

---

## 21. Open questions for the product owner

Defaults in §4 are already implemented by the PRs; these only need a *no* to change:

1. **License** — MIT assumed (PR-01 adds `LICENSE`). Prefer ISC/AGPL/none?
2. **Single-owner vs multi-user** — MVP assumes one owner created at `/setup`, extra accounts only via
   `POST /api/users` (`ALLOW_REGISTRATION=false`, which makes `POST /api/auth/register` answer 403). Should open
   registration be the default for a personal box? PR-07/PR-08 support either default; only the flag default changes.
3. **Folder delete semantics** — hard delete + typed confirmation (MVP) vs soft-delete/trash (PR-23). Hard delete
   keeps the MVP small; is that acceptable?
4. **Editor** — raw Markdown + toolbar + live preview accepted? If "Word-style" is the *primary* desire, PR-22 must
   be promoted into the MVP (+3–4 days, and PR-13 shrinks).
5. **Encryption in development** — there is **no plaintext mode**: dev/test boot with a generated key persisted to
   `.dev/note-key`, production requires a real key. Confirm that, or ask for a `content_format='plain'` escape hatch
   (schema column + codec branch, ≈ +½ day on top of PR-06).
6. **Port** — the container listens on `3000`; the host mapping comes from `HOST_PORT` (default `3000`). Any convention
   you want as the documented default in `docs/DEPLOY.md` (e.g. `HOST_PORT=8080`)?
7. **Theme/branding** — system light/dark only, or a brand color/font pass? (affects PR-08 tokens)
8. **Password reset** — no self-service reset in the MVP (no email). The supported recovery is the operator script from
   PR-07: `docker compose … exec app node apps/server/dist/scripts/reset-password.js <username>` re-hashes the password
   and drops that user's sessions, and `docs/DEPLOY.md` (PR-18) documents it under troubleshooting. **Deleting the user
   row is never a recovery path** — every other `user_id` FK is `ON DELETE CASCADE` (sessions, folders, notes, settings),
   so it destroys the account's data, and if the deleted row was the owner it also re-opens `POST /api/auth/setup` (§9.2 #3 gates
   on the owner row), letting the next visitor claim ownership — a takeover, never a recovery path.
   Open question: add an owner-facing reset in the UI (+½ day, PR-16 extension), or keep the CLI-only path?

9. **Passkey timing** — confirm PR-21 stays post-MVP (recommended: yes).
10. **Dev host OS** — every script that reads env sets its mode inline (§16's rule: `NODE_ENV=development tsx watch …`,
    `NODE_ENV=development drizzle-kit …`, `NODE_ENV=test vitest …`, `NODE_ENV=production tsx scripts/check-env.ts`),
    which assumes a POSIX shell. Windows-only contributors would need `cross-env` on **all** of them, not just `dev` —
    the DB/seed/test/preflight scripts are exactly where a missing mode becomes a hard boot failure
    (+one dependency, no other change). Add it now, or keep the scripts POSIX-only and let WSL be the documented path?

---

## Appendix A — concrete implementation sketches

Reference-level only (the PRs own the real code); these pin down the non-obvious parts.

**A.1 Name helper (`packages/contracts/src/names.ts`)** — the README's `new-file-<msepoch>.md` rule lives here and
nowhere else:

```ts
export const MD_EXT = '.md';
export const newFileName = (msEpoch: number = Date.now()) => `new-file-${msEpoch}${MD_EXT}`;
// "Draft.md" -> "Draft" (names are stored extension-free). Exactly ONE suffix is removed — which is only safe
// because isValidNoteName() below rejects a stripped name that still ends in .md.
export const stripMd = (name: string) => name.toLowerCase().endsWith(MD_EXT) ? name.slice(0, -MD_EXT.length) : name;
export const withMd = (name: string) => stripMd(name) + MD_EXT; // display only
const endsInMd = (s: string) => s.toLowerCase().endsWith(MD_EXT);
export const isValidNoteName = (raw: string): boolean => {
  const base = stripMd(raw);   // every rule runs on the STRIPPED name ("..md" → "." must fail, "foo .md" → "foo " must fail)
  return base.length > 0 && base.length <= 120 &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(base) && base === base.trim() && base !== '.' && base !== '..' &&
    // …and the stripped result may not STILL end in .md. "foo.md.md" would otherwise be stored as "foo.md":
    // that breaks the §8 "no .md in the DB" invariant, makes the stored rows `foo` and `foo.md` render
    // identically (withMd turns both into "foo.md"), and loses characters when a rename prefill strips again.
    // Rejecting is deliberate: silently stripping twice would make "foo.md.md" collide with "foo" instead.
    // This is also what makes stripMd idempotent over valid input — the property PR-05 tests:
    //   isValidNoteName(n) ⇒ stripMd(stripMd(n)) === stripMd(n)
    !endsInMd(base);
};
// Works on the extension-free base, because that is what is stored: "plan" → "plan-2" → "plan-3".
// withMd() renders the ".md"; uniquify must never emit a name that still carries the extension.
export const uniquify = (name: string, taken: Set<string>): string => { /* base, base-2, base-3 … */ };
```

**A.2 Atomic versioned content write (`notes.repo.ts`)** — one statement, so two tabs cannot both win:

```ts
const updated = await db
  .update(notes)
  .set({ contentCipher, contentIv, keyVersion, contentBytes, wordCount,
         version: sql`${notes.version} + 1`, contentUpdatedAt: new Date(), updatedAt: new Date() })
  .where(and(eq(notes.id, noteId), eq(notes.userId, userId), eq(notes.version, baseVersion)))
  .returning();
if (updated.length === 0) {
  // The UPDATE also filtered on id + userId, so zero rows means either a stale version
  // or a note that does not exist for this user. Re-read, scoped, to keep §8's "404, never 403".
  const current = await db
    .select({ contentCipher: notes.contentCipher, contentIv: notes.contentIv,
              keyVersion: notes.keyVersion, version: notes.version })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  if (current.length === 0) throw new NotFoundError(noteId);                       // route → 404 NOT_FOUND
  throw new VersionConflictError(noteId, open(current[0]), current[0].version);    // route → 409 + server content
}
```

**A.3 Envelope encryption (`crypto/envelope.ts`)**:

```ts
export function seal(plain: string, noteId: string, keyring: Keyring) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.current.key, iv);
  cipher.setAAD(Buffer.from(`note:${noteId}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { contentCipher: body, contentIv: iv, keyVersion: keyring.current.version };
}
// open() splits the trailing 16 bytes as the auth tag; any GCM failure throws → API returns INTERNAL, never blank content
```

**A.4 Tree in one query (`tree.service.ts`)** — recursive CTE with `user_id` bound once, `depth < 100` runaway
guard (the same 100-level cap PR-09 enforces at create/move, so the walk can never stop short of a folder the API
accepted — it protects against a corrupted `parent_id` cycle, not against legal depth),
`array_agg` path for breadcrumbs; assembled into `{folders: FolderNode[], notes: NoteNode[]}` and rebuilt into a
nested structure client-side by `features/tree/tree.selectors.ts`.

**A.5 Autosave state machine shape (`lib/autosave.ts`)** — `createAutosaver({debounceMs, maxUnflushedMs, settings,
save})` returning `{ onEdit(), flush(), state, conflict, error }`. States and the transitions the first draft left
implicit (PR-14's unit tests enumerate exactly this table):

| state | entered when | exits to |
| --- | --- | --- |
| `clean` | buffer equals the last saved content | `dirty` on `onEdit()` |
| `dirty` | an edit landed, debounce running | `saving` when the debounce fires or `flush()` is called |
| `saving` | one `PUT` is in flight carrying `baseVersion = v`, **remembering the exact payload it sent** | `clean` (200 ⇒ adopt the returned `version`) · `clean` **or** `dirty` **silently** when a `VERSION_CONFLICT` payload equals that in-flight snapshot (the write landed, the reply was lost — §11.4) · `conflict` (same error, different content) · `retrying` (5xx/transport) |
| `retrying` | 5xx or a transport error | `saving` on the backoff timer; `conflict`/`error` once the retry budget is spent |
| `conflict` | `VERSION_CONFLICT` **whose content differs from the in-flight snapshot** (§11.4) — buffer retained, autosave paused | "Keep mine" ⇒ `saving` with the fresh server `version`; "Use server" ⇒ `clean` |
| `error` | `401` (session gone ⇒ stop autosaving, route to `/login`, the `localStorage` draft mirror keeps the text) · `403` after the one CSRF refresh-and-replay (§10) · `404` (note deleted elsewhere ⇒ offer "save as a new note") | manual retry, or `dirty` on the next edit for the 403 case |

**Three rules that make the table safe:** at most **one** request may be in flight, an edit arriving during `saving` is
never dropped and never starts a parallel request — it parks the machine in `dirty`, and the next debounce window opens
when the in-flight request settles, always sending the newest buffer with the newest known `version`; and a
`VERSION_CONFLICT` becomes a `conflict` **only after** the §11.4 comparison shows the payload differs from the exact
snapshot that request carried, so a committed write whose response was lost settles in `clean` — or `dirty`, if the user
typed meanwhile — and never reaches the user as a banner. The hook
only
subscribes React to this machine, which is what keeps every row of the table unit-testable without a DOM.

---

*End of plan. Slice tasks in the order of §12/§13; keep this file updated whenever a decision in §4 or the task
list changes.*
