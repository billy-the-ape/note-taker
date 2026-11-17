# Note Taker — MVP Full Plan

> Status: **plan of record** for the initial MVP. Every implementation PR in this repo should cite a PR ID from
> [`§12 Work Breakdown`](#12-work-breakdown--pull-requests).
> Source of requirements: [`README.md`](../../README.md). This document is the single mapping of the whole
> repository/website and is intended to be sliced into one PR per task.
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
- Each task lists: goal, dependencies, *in-scope* files, acceptance criteria, test plan, size (`S` ≤ ½ day,
  `M` = 1–2 days, `L` = 3–4 days). Sizes are for one engineer familiar with the stack.
- **Merge order:** any task may be opened as soon as its dependencies are merged. Where a task only needs the
  *shape* of another task's output (e.g. UI needing API payloads), build against
  `packages/contracts` (PR-05) and mock handlers instead of waiting — see [§13](#13-dependency-graph--parallel-execution-tracks).
- Every PR must keep CI green (lint + typecheck + tests + coverage gate) and update the docs it invalidates
  (`README.md`, `docs/ARCHITECTURE.md`, ADRs) in the same PR — required by [`AGENTS.md`](../../AGENTS.md).
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
| Security | Passwords hashed with argon2id; session cookies `HttpOnly`/`Secure`/`SameSite=Lax`; note bodies encrypted at rest (AES-256-GCM); ownership enforced on every query |
| Code quality | 100% typechecked (TS `strict`), zero lint errors, unit + integration tests with enforced coverage floor |
| Data scale assumption | Single-user / small-team: thousands of notes, ~10⁴ folders; in-process search is acceptable |

---

## 3. Scope: MVP vs. post-MVP

### 3.1 In the MVP (shipped by PR-20)

- Username + password auth (register on first run / explicit invite or open-registration flag, login, logout, change password).
- Session-based auth with DB-backed sessions and cookie transport.
- Folder tree: create, rename, move, delete (with explicit cascade confirmation), unlimited nesting, cycle-safe.
- Notes: create (name prompt with `new-file-<msepoch>.md` prefill, fixed `.md`), rename, move, delete.
- Markdown editing: raw Markdown buffer + toolbar that inserts/wraps Markdown, live preview pane (toggle: split / edit-only / preview-only).
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
| Q1 | "Backend stores saved notes efficiently & securely. 2 way encrypted?" | **Yes — authenticated encryption at rest.** `notes.content_cipher` stored as `bytea`, AES-256-GCM, per-record 12-byte random IV, master key from `NOTE_ENCRYPTION_KEY` (base64, 32 bytes), `key_version` column enables rotation. ADR-0002. | Deterministic/simple; decryption only in the API process; ciphertext+tag in one column (tag appended by `node:crypto`). Trade-off: no Postgres `FULLTEXT`/`pg_trgm` on bodies → search decrypts in-process (fine at MVP scale). If `NOTE_ENCRYPTION_KEY` is missing the app **refuses to start in production** and runs plaintext only in `development` with a loud warning. |
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
| Runtime | Node.js 22 LTS, TypeScript 5.x `strict`, ESM everywhere | Matches local env (`node v22.22.1`); native `fetch`, `crypto`, `--test` fallback |
| Package mgmt | pnpm workspaces (local `pnpm 12.3.4`), `pnpm dev/build/test` scripts | Fast, strict deps, workspace linking for `packages/contracts` |
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
├── AGENTS.md / CLAUDE.md / .clinerules/*       (exists) untouched except PR-20 doc pass
├── .github/
│   └── workflows/
│       ├── CI.yml                             (exists, placeholder) REPLACED in PR-03
│       │                                      ⚠ keep `name: CI` — claude-review.yml triggers on it
│       └── claude-review.yml                  (exists) untouched
├── .editorconfig  .gitignore  .dockerignore  .nvmrc  LICENSE      PR-01
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  PR-01
├── .env.example                               PR-01 (keys added in PR-06)
├── Makefile                                   PR-02 (dev/db/build/test entry points)
├── docs/
│   ├── plans/MVP-FULL-PLAN.md                 (this file)
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
│   └── entrypoint.sh                          PR-18  (migrate → exec node)
├── scripts/
│   ├── generate-keys.ts                       PR-06  (NOTE_ENCRYPTION_KEY)
│   ├── rotate-note-key.ts                     PR-06  (re-encrypt all rows)
│   ├── seed-demo.ts                           PR-02  (dev user + sample tree)
│   └── check-env.ts                           PR-18  (fail fast on missing/prod-unsafe env)
├── packages/
│   └── contracts/                             PR-05  (no runtime deps except zod)
│       ├── package.json  tsconfig.json  vitest.config.ts
│       └── src/
│           ├── index.ts                       barrel export
│           ├── api-envelope.ts                ApiErrorCode, errorResponseSchema, paginated/list helpers
│           ├── auth.schemas.ts                registerSchema, loginSchema, sessionUserSchema, changePasswordSchema
│           ├── tree.schemas.ts                folderNodeSchema, noteNodeSchema, treeResponseSchema
│           ├── notes.schemas.ts               createNoteSchema, renameMoveSchema, contentUpdateSchema, noteSchema
│           ├── folders.schemas.ts             createFolderSchema, patchFolderSchema, deleteOptionsSchema
│           ├── settings.schemas.ts            settingsSchema, patchSettingsSchema
│           ├── search.schemas.ts              searchQuerySchema, searchResultSchema
│           ├── names.ts                       NOTE_NAME rules + newFileName(msEpoch) + stripExtension()
│           ├── routes.ts                      ROUTES path constants shared by client & server
│           └── *.test.ts                      unit tests (name rules, uniqueness suffixing, validation edges)
└── apps/
    ├── server/                                Fastify + Drizzle
    │   ├── package.json  tsconfig.json
    │   ├── drizzle.config.ts                  PR-04
    │   ├── vitest.config.ts (unit)  vitest.integration.config.ts  PR-04
    │   ├── migrations/                        PR-04 (committed SQL, generated by drizzle-kit)
    │   └── src/
    │       ├── index.ts                       PR-01 (bootstrap: env → buildApp → migrate → listen → shutdown)
    │       ├── app.ts                         PR-01 factory `buildApp(deps)` — DI so tests never bind a port
    │       ├── env.ts                         PR-01 zod-parsed process.env, prod invariants
    │       ├── logger.ts                      PR-01 pino
    │       ├── db/schema.ts                   PR-04 drizzle table definitions (single source of truth)
    │       ├── db/client.ts                   PR-04 postgres.js pool + drizzle instance
    │       ├── db/migrate.ts                  PR-04 programmatic migration runner
    │       ├── db/repositories/users.repo.ts       PR-07
    │       ├── db/repositories/sessions.repo.ts    PR-07
    │       ├── db/repositories/folders.repo.ts     PR-09
    │       ├── db/repositories/notes.repo.ts       PR-09 (content crypto applied here, PR-10 wiring)
    │       ├── db/repositories/settings.repo.ts    PR-16
    │       ├── db/repositories/*.test.ts      integration (real DB)
    │       ├── crypto/envelope.ts             PR-06 encrypt/decrypt AES-256-GCM
    │       ├── crypto/keys.ts                 PR-06 keyring from env (current + previous versions)
    │       ├── crypto/envelope.test.ts        PR-06 roundtrip, tamper, wrong key, rotation
    │       ├── plugins/auth-guard.ts          PR-07 session resolution + `requireAuth` preHandler
    │       ├── plugins/error-handler.ts       PR-05 zod/Drizzle/domain errors → envelope
    │       ├── plugins/csrf.ts                PR-07 cookie-to-header double submit
    │       ├── plugins/static-spa.ts          PR-12 serve ../web/dist + SPA fallback (skip /api)
    │       ├── http/rate-limit.ts             PR-07 in-memory sliding window (login)
    │       ├── services/auth.service.ts       PR-07
    │       ├── services/folder.service.ts     PR-09 rename/move/cycle guard/cascade
    │       ├── services/note.service.ts       PR-09/PR-10 create, content update + version, rename/move
    │       ├── services/tree.service.ts       PR-09 recursive CTE tree assembly
    │       ├── services/search.service.ts     PR-11
    │       ├── routes/health.routes.ts        PR-01
    │       ├── routes/auth.routes.ts          PR-07
    │       ├── routes/users.routes.ts         PR-07 (admin create/list when registration closed)
    │       ├── routes/tree.routes.ts          PR-09
    │       ├── routes/folders.routes.ts       PR-09
    │       ├── routes/notes.routes.ts         PR-09 + PR-10
    │       ├── routes/search.routes.ts        PR-11
    │       ├── routes/settings.routes.ts      PR-16
    │       ├── routes/*.test.ts               integration through `buildApp` + `app.inject()`
    │       ├── domain/errors.ts               PR-05 typed domain errors
    │       ├── domain/name.ts                 server-side wrapper around contracts `names.ts`
    │       └── test/                          PR-04 helpers: `withDb()`, `withApp()`, `fixtures.ts`
    └── web/                                   Vite + React SPA
        ├── package.json  tsconfig.json  vite.config.ts  index.html  vitest.config.ts   PR-01
        ├── playwright.config.ts               PR-19
        ├── e2e/                               PR-19 auth.spec.ts, notes.spec.ts, autosave.spec.ts
        └── src/
            ├── main.tsx                       PR-01 (Router + QueryClient + providers)
            ├── styles/globals.css             PR-01 (Tailwind v4 @theme tokens)
            ├── routes/__root.tsx              PR-01
            ├── routes/index.tsx               PR-01 placeholder → redirect rule finalized in PR-08
            ├── routes/login.tsx               PR-08
            ├── routes/setup.tsx               PR-08 first-run account creation
            ├── routes/app/__layout.tsx        PR-12 auth guard + AppShell outlet
            ├── routes/app/index.tsx           PR-12 "no note selected" / recent notes
            ├── routes/app/note.$noteId.tsx    PR-13/14 editor page
            ├── routes/app/settings.tsx        PR-16
            ├── routes/app/search.tsx          PR-17
            ├── lib/api.ts                     PR-05 typed fetch wrapper (+ error mapping, CSRF header)
            ├── lib/queryClient.ts             PR-05
            ├── lib/markdown.ts                PR-13 toolbar transforms (pure, unit-tested)
            ├── lib/autosave.ts                PR-14 state machine (pure, unit-tested)
            ├── lib/name.ts                    PR-15 thin wrapper over contracts names.ts
            ├── features/auth/{session.tsx, auth.api.ts, useSession.ts}   PR-08
            ├── features/tree/{tree.queries.ts, tree.selectors.ts, tree.mutations.ts}  PR-12
            ├── features/notes/{note.queries.ts, note.mutations.ts}       PR-13/14
            └── components/
                ├── ui/{Button,Input,Field,Dialog,Menu,Toast,Spinner}.tsx  PR-08 (grown by later PRs)
                ├── layout/{AppShell,Sidebar,TopBar,StatusBar}.tsx         PR-12
                ├── tree/{FolderTree,FolderRow,NoteRow,TreeContextMenu}.tsx PR-12
                ├── editor/{EditorPane,MarkdownEditor,EditorToolbar,PreviewPane}.tsx PR-13
                ├── editor/{SaveStatus,ConflictBanner}.tsx                 PR-14
                └── notes/{NewNoteDialog,RenameDialog,MoveDialog,DeleteConfirm}.tsx  PR-15
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
`apps/server/migrations/`. UUIDv7 PKs (`crypto.randomUUID()` is acceptable; keep one helper `newId()`).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() fallback for defaults

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  username          text NOT NULL,                       -- compared case-insensitively via unique index
  password_hash     text NOT NULL,                       -- argon2id encoded string
  display_name      text,
  role              text NOT NULL DEFAULT 'owner'        -- 'owner' | 'member' (multi-user later)
                    CHECK (role IN ('owner','member')),
  password_set_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));

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
  parent_id  uuid REFERENCES folders(id) ON DELETE CASCADE,   -- NULL = root; cycle check in service layer
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
  content_cipher    bytea NOT NULL DEFAULT '',              -- AES-256-GCM ciphertext || 16-byte tag
  content_iv        bytea NOT NULL DEFAULT '',              -- 12 bytes, per-write random
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

CREATE TABLE settings (
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
| Every folder/note belongs to exactly one user | `user_id` NOT NULL + `WHERE user_id = auth.userId` on **every** repository query; cross-user access returns `404`, never `403` (no enumeration) |
| Sibling names unique (case-sensitive, trimmed, no `/`, no control chars, ≤ 120 chars) | DB unique index + Zod refinements in `contracts` |
| Note name never contains the `.md` extension in the DB | `stripExtension()` in `contracts/names.ts`, applied in `note.service.ts` |
| A folder cannot be moved inside itself | `folder.service.ts` CTE ancestor walk → `CONFLICT` |
| `note.version` monotonic | conditional `UPDATE … WHERE id = $1 AND version = $2 RETURNING` → 0 rows ⇒ `409` |
| Deleting a folder removes descendants | `ON DELETE CASCADE`, gated by explicit `?cascade=true` in the API |
| Notes **and** folders may live at the root of the tree | `notes.folder_id` and `folders.parent_id` are both nullable, `NULL` = root; the `COALESCE`-based unique indexes above keep sibling names unique for root-level rows too |
| Note content is never stored in plaintext in production | `crypto/envelope.ts` is the only writer of `content_cipher`; `env.ts` requires `NOTE_ENCRYPTION_KEY` when `NODE_ENV=production` |

No soft-delete/trash in the MVP (backlog `PR-23`); deletes are hard, guarded by a typed confirmation dialog
(type the folder/note name) so accidental cascade deletes require deliberate typing.

---

## 9. HTTP API contract

Base path `/api`. Content type `application/json; charset=utf-8`. All bodies validated with the Zod schemas in
`packages/contracts` via `fastify-type-provider-zod`, so `docs/API.md`, the server, and the client share one truth.

### 9.1 Error envelope (every non-2xx)

```jsonc
{ "error": { "code": "VALIDATION", "message": "name already exists in this folder",
             "details": [{ "path": "name", "message": "must be unique" }], "requestId": "…" } }
```

`code ∈ VALIDATION | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | VERSION_CONFLICT |
PAYLOAD_TOO_LARGE | INTERNAL`. Mapped centrally in `plugins/error-handler.ts` from typed domain errors in
`domain/errors.ts`. `requestId` is echoed in logs for support.

### 9.2 Endpoints

| # | Method + path | Auth | Request (contract schema) | Success response | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /api/health` | none | — | `{status:'ok', db:'ok', version}` | also `GET /api/healthz` for the Docker `HEALTHCHECK` |
| 2 | `GET /api/auth/status` | none | — | `{needsSetup:boolean}` | true iff `users` is empty → client routes to `/setup` |
| 3 | `POST /api/auth/setup` | none, **only when `needsSetup`** | `registerSchema {username, password, displayName?}` | `200 {user}` + session cookie | first-run bootstrap; returns `CONFLICT` once a user exists |
| 4 | `POST /api/auth/login` | none | `{username, password}` | `200 {user}` + `note_session` cookie | argon2id verify, timing-safe dummy hash, rate-limited |
| 5 | `POST /api/auth/logout` | yes | — | `204` | deletes session row, clears cookie |
| 6 | `GET /api/auth/session` | optional | — | `{user\|null, expiresAt?}` | used on boot to rehydrate UI |
| 7 | `POST /api/auth/password` | yes | `{currentPassword, newPassword}` | `204` | rotates + deletes all other sessions |
| 8 | `POST /api/users` | owner | `{username, password}` | `201 {user}` | only when `ALLOW_REGISTRATION=false`; otherwise `FORBIDDEN` |
| 9 | `GET /api/users` | owner | — | `{users:[{id,username,role,createdAt}]}` | minimal admin surface |
| 10 | `GET /api/tree` | yes | — | `{folders:[FolderNode], notes:[NoteNode]}` | full tree metadata, **no content**; single query via recursive CTE; sized for MVP scale |
| 11 | `POST /api/folders` | yes | `{name, parentId\|null}` | `201 FolderNode` | 409 on sibling clash |
| 12 | `PATCH /api/folders/:id` | yes | `{name?, parentId?}` | `200 FolderNode` | rename and/or move; cycle guard |
| 13 | `DELETE /api/folders/:id` | yes | query `cascade=true` | `204` | without `cascade=true` and non-empty ⇒ `CONFLICT` |
| 14 | `POST /api/notes` | yes | `{name?, folderId\|null, content?}` | `201 NoteWithContent` | `name` omitted → server generates `new-file-<msepoch>` and uniquifies it (`folderId: null` = root) |
| 15 | `GET /api/notes/:id` | yes | — | `{…NoteNode, content, version}` | decrypts; `ETag: W/"v<version>"` |
| 16 | `PUT /api/notes/:id/content` | yes | `{content, baseVersion}` | `{…NoteNode, content, version:version+1}` | `If-Match` optional; `baseVersion` mismatch ⇒ `VERSION_CONFLICT` + current server content |
| 17 | `PATCH /api/notes/:id` | yes | `{name?, folderId\|null}` | `200 NoteNode` | rename / move (`folderId: null` = move to root); `notes.name` stays extension-free |
| 18 | `DELETE /api/notes/:id` | yes | — | `204` | |
| 19 | `GET /api/search?q=&limit=` | yes | — | `{results:[{noteId,name,folderPath,snippet,score}]}` | name match in SQL + body match after decrypt (cap 500 candidates) |
| 20 | `GET /api/settings` / `PATCH /api/settings` | yes | `patchSettingsSchema` | `Settings` | `autosave`, `theme` |

Payload cap: 1 MiB note body (Fastify `bodyLimit`, → `PAYLOAD_TOO_LARGE`); UI warns at 900 KiB.

### 9.3 Concurrency & idempotency rules

- Content writes are **versioned**, not last-write-wins (see §11.4).
- `POST /api/notes` and `POST /api/folders` are idempotent-by-name inside a folder: a duplicate create returns
  `CONFLICT` including the existing id, so a double-click of "Create" in the UI ends with one note, not two.
- All mutations require the CSRF header (`X-CSRF-Token`) except `login`/`setup` (which require `Origin` check).


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
- Security headers via `@fastify/helmet`: `CSP` for the SPA (no `unsafe-eval`; inline styles only via nonce if
  needed), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Markdown preview is **sanitized** (`rehype-sanitize`): no raw HTML, no `javascript:` URLs, `rel="noopener"`.

**Passwords & brute force**

- argon2id via `@node-rs/argon2` with OWASP-ish parameters (`memoryCost 65536, timeCost 3, parallelism 1`),
  per-password random salt, encoded string stored in `password_hash`.
- Password policy: ≥ 10 chars, no username equality, ≤ 512 bytes (argon2 pre-hash guard).
- Login rate limit: in-process sliding window (10 failures / 15 min per `lower(username)`+IP) **plus** durable rows
  in `auth_attempts` for audit; on trip → `429 RATE_LIMITED` with `Retry-After`.
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
  `{"1": "<base64>"}`) so `scripts/rotate-note-key.ts` can read old rows and rewrite them with the new key.
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
- `scripts/check-env.ts` refuses to boot in production when: `NOTE_ENCRYPTION_KEY` missing/≠32 bytes,
  `SESSION_TTL_DAYS` > 365, `ALLOW_REGISTRATION=true` with no `INITIAL_*` credentials set, `NODE_ENV` unset.

---

## 11. Frontend architecture (routes, state, autosave, editor)

### 11.1 Routes (TanStack Router, file-based)

| Path | Guard | Purpose |
| --- | --- | --- |
| `/setup` | only when `needsSetup` | create the first account (README: self-hosted, first-run) |
| `/login` | redirect away when authed | username + password, error + rate-limit messaging |
| `/app` | auth | AppShell; default view = recent notes + "New note" |
| `/app/note/$noteId` | auth | editor + preview for one note |
| `/app/search` | auth | search results (`?q=`) |
| `/app/settings` | auth | autosave toggle, theme, change password, sign out all sessions |
| `*` | — | redirect: authed → `/app`, else → `/login` or `/setup` |

Route guards live in `routes/app/__layout.tsx` (`beforeLoad` reads the session context) — never per-page.

### 11.2 State

| Kind | Where |
| --- | --- |
| Server state (tree, note content, settings, session) | TanStack Query, cache keys `['tree',userId]`, `['note',id]`, `['settings']` |
| Mutations | TanStack Query mutations with optimistic tree updates + rollback on error |
| Editor buffer (uncommitted text) | local component state + autosave engine ref; mirrored to `localStorage['note-draft:<id>']` so a browser crash keeps the last buffer |
| Transient UI (dialogs, preview mode, sidebar width) | local state + a tiny `ui` store for sidebar/preview mode persisted in `localStorage` |

No global client store (no Redux/Zustand) in the MVP — Query + Router cover it, and less state means fewer bugs.

### 11.3 Editor (Q3)

- `MarkdownEditor`: CodeMirror 6 with the Markdown language extension, soft wrap, `Cmd/Ctrl+B/I/K` shortcuts,
  line numbers off, `aria-label="note content"`.
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
                                   └────429/network──▶ retry(backoff 1s,2s,4s,8s,30s) ──▶ saving
saving/clean ──VERSION_CONFLICT──▶ conflict ──(user picks)──▶ overwrite | loadServer
```

- Flush triggers: debounce (default 1200 ms), `maxUnflushedMs = 10 000`, `Ctrl/Cmd+S`, note switch, folder
  rename/move affecting the open note, `window blur`, `visibilitychange → hidden`, `pagehide`
  (`navigator.sendBeacon` fallback where `PUT` needs the CSRF header; otherwise a synchronous-ish `fetch(keepalive:true)`).
- Every write sends `baseVersion = lastKnownServerVersion`. On `VERSION_CONFLICT` the server returns its current
  content; the UI shows `ConflictBanner` with *Keep mine* / *Use server* / *Copy server text*, never silently overwrites.
- `SaveStatus` pill in `StatusBar`: `Saved 12:03:11`, `Saving…`, `Unsaved changes`, `Retrying (2)…`, `Conflict`,
  `Autosave off — Ctrl+S to save`.
- When `settings.autosave === false`: no debounce writes; `Ctrl/Cmd+S` and the explicit Save button still work;
  navigating away with a dirty buffer prompts ("Save / Discard / Stay").
- Autosave is disabled while a `CONFLICT` state is unresolved.

### 11.5 UX details that the README implies and must not be skipped

- **New note dialog**: name input pre-filled with `new-file-<Date.now()>.md`, the `.md` rendered as a fixed suffix
  (input value excludes it; suffix is a sibling element so it cannot be edited or deleted), target folder defaults
  to the selected folder/root, "Create" is disabled while the name is invalid or collides (debounced
  uniqueness check against the tree cache, no extra endpoint).
- Rename dialogs reuse the same component with the current name and the same fixed `.md` suffix for notes.
- Everything reachable by keyboard: tree arrow-key navigation, `Enter` to open, `F2` rename, `Delete` delete,
  `Ctrl/Cmd+N` new note, `Ctrl/Cmd+K` (search *page* link in MVP, palette is backlog).
- Destructive actions (folder with children, note delete) require typing the item name.
- Toasts on every failed mutation with the server `error.message`.


---

## 12. Work breakdown — pull requests

Total MVP estimate: **~26–32 engineer-days** serial; **~3 weeks calendar** with 2 engineers using the parallel
tracks in [§13](#13-dependency-graph--parallel-execution-tracks).

Global PR rules (apply to every task below, not repeated): conventional-commit titles
(`feat:`, `fix:`, `chore:`, `test:`, `docs:`); PR body starts with `Task: PR-NN`; CI must be green; every PR
that changes behavior also updates the affected doc (`README.md`, `docs/API.md`, `docs/DATA-MODEL.md`, ADRs);
no PR may lower a coverage threshold; every new DB column ships with a generated migration in the same PR.

### PR index

| ID | Title | Size | Depends on | Track |
| --- | --- | --- | --- | --- |
| PR-01 | Monorepo scaffold, tooling, hello-world app | M | — | A Foundation |
| PR-02 | Dev infra: Postgres in Docker, Makefile, seed | S | 01 | A |
| PR-03 | Real CI (replaces placeholder `CI.yml`) | M | 01 | A |
| PR-04 | DB schema, migrations, repository harness | L | 01, 02 | B Data |
| PR-05 | Shared contracts (Zod DTOs, error envelope, typed client) | M | 01 | B |
| PR-06 | Envelope encryption + key mgmt + rotation | M | 04, 05 | B |
| PR-07 | Auth core (users, sessions, cookies, CSRF, rate limit) | M | 04, 05 | C Auth |
| PR-08 | Auth UI (setup/login, session context, UI kit) | M | 05, 07 | C |
| PR-09 | Folders & notes CRUD API + tree | L | 05, 07 | D Domain |
| PR-10 | Note content read/write + versioning | M | 06, 09 | D |
| PR-11 | Search API | M | 10 | D |
| PR-12 | App shell + folder tree UI | L | 08, 09 | E UI |
| PR-13 | Markdown editor + toolbar + preview | L | 12, 10 | E |
| PR-14 | Autosave engine + conflict UX | M | 10, 13 | E |
| PR-15 | New-note dialog (`new-file-<ms>.md`) | S | 12, 09 | E |
| PR-16 | Settings (autosave, theme, password) | M | 07, 14 | E |
| PR-17 | Search UI | S | 11, 12 | E |
| PR-18 | Production Docker image + compose + deploy docs | M | 01–16 | F Ship |
| PR-19 | Playwright e2e + CI e2e job + coverage ratchet | M | 08–18 | F |
| PR-20 | Docs pass (README, ADRs, ARCHITECTURE, AGENTS.md) | S | 18, 19 | F |

---

#### PR-01 — Monorepo scaffold, tooling, runnable hello-world app
**Branch:** `feat/pr-01-scaffold` · **Size:** M · **Depends on:** —

- **Goal:** a cloneable repo where `pnpm i && pnpm dev` serves a page and `pnpm build` produces a deployable
  artifact; all quality gates exist from day one so later PRs can only *add* tests, never bolt on tooling.
- **Create:** `package.json` (root, `packageManager`, workspace scripts: `dev build lint format typecheck test
  test:integration coverage db:generate db:migrate db:seed`), `pnpm-workspace.yaml`, `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `biome.json`,
  `.editorconfig`, `.gitignore`, `.dockerignore`, `.nvmrc`, `LICENSE` (MIT — confirm in §21), `.env.example`,
  `apps/server/{package.json,tsconfig.json,vitest.config.ts,src/{index.ts,app.ts,env.ts,logger.ts,routes/health.routes.ts}}`,
  `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/{main.tsx,routes/__root.tsx,styles/globals.css}}`,
  minimal `apps/web/src/routes/index.tsx` placeholder that renders a "coming soon" card.
- **Acceptance:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0; `GET /api/health` returns
  `{status:'ok'}`; `vite` proxies `/api` to `:3000`; server built with `tsc` (no bundler) to `apps/server/dist`,
  web built to `apps/web/dist`; `env.ts` rejects unknown/missing required vars and is unit-tested.
- **Tests:** `env.test.ts` (prod invariants), `app.test.ts` (`app.inject('/api/health')` = 200).
- **Out of scope:** any DB code, any real UI.

#### PR-02 — Local dev infrastructure (Postgres in Docker, Make, seed)
**Branch:** `chore/pr-02-dev-infra` · **Size:** S · **Depends on:** PR-01

- **Create:** `docker/compose.dev.yml` (`postgres:16-alpine`, named volume, `POSTGRES_*` from `.env`, healthcheck,
  host port 5432), `Makefile` (`make db-up db-down db-reset dev build test coverage`), `scripts/seed-demo.ts`
  (idempotent: demo user + tree) — invoked by `pnpm db:seed`.
  Every `make` target pins the full invocation — `docker compose --env-file .env -f docker/compose.dev.yml …` —
  because Compose auto-loads `.env` from the compose file's own directory (`docker/`), not the repo root; PR-18
  follows the same rule for `docker/compose.yml`, so there is one convention to remember (see §15).
- **Acceptance:** `make db-up && pnpm db:migrate && pnpm db:seed && pnpm dev` works from a cold clone; a README
  "Local development" section documents the 4 commands; no committed credentials (dev defaults only); changing
  `POSTGRES_PORT` in the repo-root `.env` actually changes the host port after `make db-up` (proves the env file is
  really being read).
- **Tests:** `scripts/seed-demo.ts` guarded by `NODE_ENV !== 'production'`; nothing to unit-test.
- **Out of scope:** production image (PR-18), CI (PR-03).

#### PR-03 — Real CI (replaces the placeholder workflow)
**Branch:** `ci/pr-03-real-ci` · **Size:** M · **Depends on:** PR-01 (lands before PR-04 if possible; PR-04 can
merge with the placeholder still in place — see note)

- **Modify:** `.github/workflows/CI.yml` — **delete the `placeholder` job but keep `name: CI` and the same
  triggers**, because `claude-review.yml` runs `on: workflow_run: workflows: ["CI"]`. Do not rename the workflow.
- **Jobs:** `quality` (checkout → `pnpm/action-setup` v12 → `actions/setup-node` cache `pnpm` → `pnpm install --frozen-lockfile`
  → `pnpm lint && pnpm typecheck`), `unit` (`pnpm coverage`, uploads `coverage/` artifact, enforces thresholds),
  `integration` (`services: postgres:16` with healthcheck + `DATABASE_URL` → `pnpm test:integration`),
  `build` (`pnpm build` + `docker build` smoke with `cache-from`), later PR-19 adds `e2e` (Playwright, `pnpm exec
  playwright install --with-deps chromium`, `apps/web/dist` + API in the same job).
- **Acceptance:** all four jobs pass on a PR that touches nothing but the workflow; `pnpm install --frozen-lockfile`
  (so `pnpm-lock.yaml` must be committed); a deliberately failing test in a throwaway branch is proven red;
  concurrency + `permissions: contents: read` retained; the Claude review workflow still triggers (verify via the
  `workflow_run` listing after merge).
- **Out of scope:** deployment/publishing, main-branch Docker image push.

#### PR-04 — DB schema, migrations, repository harness
**Branch:** `feat/pr-04-db-schema` · **Size:** L · **Depends on:** PR-01, PR-02

- **Create:** `apps/server/drizzle.config.ts`, `db/schema.ts` (all tables + indexes from §8), `db/client.ts`,
  `db/migrate.ts` (+ wire into `index.ts` bootstrap), first migration in `migrations/`, `test/helpers/db.ts`
  (spin/truncate against `DATABASE_URL`, transaction-per-test or truncate-all fixture), `test/helpers/app.ts`,
  `test/fixtures.ts`, `docs/DATA-MODEL.md`, repositories for `users`, `sessions`, `folders`, `notes`
  (notes repo initially writes/reads **plaintext** — PR-06 swaps in the envelope behind the same interface).
- **Acceptance:** `pnpm db:generate && pnpm db:migrate` idempotent on a fresh and existing DB; integration tests
  prove: sibling uniqueness (folder & note), **root-level rows work** (`folders.parent_id IS NULL` and
  `notes.folder_id IS NULL` insert, and two root notes with the same name collide while a root note and a note inside
  a folder do not), cascade delete of nested folders, `notes.version` conditional update
  returns 0 rows on stale `baseVersion`, cross-user select returns nothing.
- **Tests:** ≥ 15 integration assertions; coverage floor for `db/repositories` ≥ 80%.
- **Out of scope:** HTTP routes, auth, crypto.

#### PR-05 — Shared contracts (Zod DTOs, error envelope, typed client)
**Branch:** `feat/pr-05-contracts` · **Size:** M · **Depends on:** PR-01
*(Unblocks PR-07…PR-17; land it as early as possible — it is the contract the parallel tracks build against.)*

- **Create:** the whole `packages/contracts` package per §7 + `docs/API.md` documenting §9 with request/response
  examples; `apps/web/src/lib/api.ts` typed fetch wrapper (`json()`, `ApiError`, CSRF header injection, 401
  handling hook) and `queryClient.ts`.
- **Key content:** `names.ts` =
  `NOTE_NAME_MAX=120`, `NOTE_NAME_RE` (no `/ \ : * ? " < > |`, no control chars, no leading/trailing space, no `.`/`..`),
  `newFileName(msEpoch) => \`new-file-${msEpoch}.md\``, `splitExtension(name)`, `ensureMd(name)`, `uniquify(name, taken)`
  (`…-2.md`, `-3.md`), plus `createNoteSchema.superRefine` enforcing them; folder name rules (no extension handling).
- **Acceptance:** `pnpm -w typecheck` resolves contracts from both apps; contract unit tests cover name rules
  (unicode, 121 chars, path chars, existing sibling), error envelope typing, `uniquify` sequences.
- **Coverage:** ≥ 90% lines and ≥ 85% branches in `packages/contracts` (the `packages/contracts` row of the §14
  threshold table: 90/85 here, ratcheting to 95/90 after PR-19; pure module, no excuse).
- **Out of scope:** server route registration (comes with each route PR).

#### PR-06 — Envelope encryption module + key management + rotation script
**Branch:** `feat/pr-06-encryption` · **Size:** M · **Depends on:** PR-04, PR-05

- **Create:** `crypto/keys.ts` (parse `NOTE_ENCRYPTION_KEY` + `NOTE_ENCRYPTION_KEY_PREVIOUS`, validate 32 bytes,
  expose `keyring`, fingerprint log), `crypto/envelope.ts` (`encrypt(plain, {keyVersion, aad}) → {cipher, iv,
  keyVersion}`, `decrypt(...)`, `sealNoteContent()/openNoteContent()`), refactor `notes.repo.ts` to store
  `content_cipher/content_iv/key_version/content_bytes/word_count`, `scripts/generate-keys.ts`,
  `scripts/rotate-note-key.ts` (streams rows, re-encrypts, batched in transactions, idempotent, `--dry-run`),
  `.env.example` additions, ADR-0002 stub.
- **Acceptance:** round-trip test; tamper test (flip a ciphertext byte ⇒ `decrypt` throws ⇒ API surfaces
  `INTERNAL` + logs note id, never blank content); wrong-key test; `key_version` preserved after rotation;
  server refuses to boot in production without a valid key.
- **Tests:** ≥ 12 unit assertions (including AAD mismatch across two note ids ⇒ decrypt fails).
- **Out of scope:** per-user keys, KMS integration.

#### PR-07 — Auth core (users, sessions, cookies, CSRF, rate limit, guards)
**Branch:** `feat/pr-07-auth-api` · **Size:** M · **Depends on:** PR-04, PR-05

- **Create:** `db/repositories/{users,sessions}.repo.ts` final forms, `services/auth.service.ts`,
  `routes/auth.routes.ts` (status/setup/login/logout/session/password), `routes/users.routes.ts`,
  `plugins/auth-guard.ts`, `plugins/csrf.ts`, `http/rate-limit.ts`, argon2 hashing utils, `auth_attempts` writes.
- **Acceptance:** integration tests: first-run `needsSetup=true` → `setup` creates owner + session; `setup` after
  that ⇒ `CONFLICT`; login success/failure (uniform 401 `UNAUTHORIZED` message); cookie flags asserted in responses;
  logout invalidates (subsequent `GET /api/auth/session` → `user:null`); password change kills other sessions;
  11th bad login in 15 min ⇒ 429; missing CSRF header on a mutation ⇒ 403; session expiry honored.
- **Out of scope:** login UI (PR-08), passkeys (backlog), OAuth/2FA.

#### PR-08 — Auth UI (setup, login, session context, route guards, UI kit v1)
**Branch:** `feat/pr-08-auth-ui` · **Size:** M · **Depends on:** PR-05, PR-07
*(Can start against mocked handlers right after PR-05.)*

- **Create:** `routes/{setup,login}.tsx`, `features/auth/*`, `components/ui/*` (Button, Input, Field, Dialog, Menu,
  Toast, Spinner — Radix primitives + Tailwind), `StatusBar` shell stub, Tailwind theme tokens
  (light/dark via `prefers-color-scheme` default), global error/not-found boundaries.
- **Acceptance (playwright-able):** unauth visit → `/login`; `needsSetup` → `/setup`; wrong password shows the
  server message; success lands on `/app`; refresh keeps the session; sign-out returns to `/login`;
  `/login` when authed redirects to `/app`; password inputs have labels + autocomplete attrs; Vitest component
  tests for the form validation + error rendering.
- **Out of scope:** the app shell content (PR-12), settings page (PR-16).

#### PR-09 — Folders & notes CRUD API + tree
**Branch:** `feat/pr-09-notes-api` · **Size:** L · **Depends on:** PR-05, PR-07 (schema from PR-04)

- **Create:** `db/repositories/{folders,notes}.repo.ts` final forms, `services/{folder,note,tree}.service.ts`,
  `routes/{tree,folders,notes}.routes.ts`, `domain/errors.ts` mappings, `domain/name.ts`.
- **Behavior:** `GET /api/tree` one recursive CTE (ordered folders-then-notes, `name` collation `C`);
  create/rename/move with sibling-uniqueness ⇒ `CONFLICT` (body carries the conflicting `id`); move-to-self/descendant
  ⇒ `CONFLICT`; delete folder requires `cascade=true` when non-empty; `POST /api/notes` with no `name` generates
  `new-file-<msepoch>` then `uniquify`; cross-user id in any path/query ⇒ `404`.
- **Acceptance:** integration suite covers each behavior above plus: 3-level nesting, rename into a sibling
  occupied name, move folder A under its own child B rejected, cascade delete removes nested notes (and content
  rows), **create at root (`folderId: null`) and move a note back to root both work**, tree depth 50 renders
  without recursion errors (CTE depth guard at 100).
- **Tests:** ≥ 25 assertions; `services` coverage ≥ 85%.
- **Out of scope:** content versioning endpoint (PR-10), search (PR-11), UI (PR-12).

#### PR-10 — Note content read/write with versioning + autosave-safe writes
**Branch:** `feat/pr-10-content-api` · **Size:** M · **Depends on:** PR-06, PR-09

- **Create:** `PUT /api/notes/:id/content` handler + service (`baseVersion` compare in one SQL statement),
  `ETag`/`If-Match` support, `content_bytes/word_count/content_updated_at` maintenance, 1 MiB body limit +
  `PAYLOAD_TOO_LARGE`, concurrent-write test with `Promise.all`.
- **Acceptance:** two clients on the same version ⇒ one 200, one `VERSION_CONFLICT` carrying server `content` +
  `version`; empty-string content allowed (a legitimately emptied note); write with `If-Match` matching a stale
  ETag ⇒ `VERSION_CONFLICT`; no partial writes when the process is killed mid-request (single statement).
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

- **Create:** `routes/app/{__layout,index}.tsx`, `components/layout/{AppShell,Sidebar,TopBar,StatusBar}.tsx`,
  `components/tree/*`, `features/tree/*`, `components/notes/{RenameDialog,MoveDialog,DeleteConfirm}.tsx`
  (shared dialog forms), `plugins/static-spa.ts` on the server so a built SPA is served from the API port.
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
**Branch:** `feat/pr-14-autosave` · **Size:** M · **Depends on:** PR-10, PR-13

- **Create:** `lib/autosave.ts` (pure state machine) + `useAutosave()` hook, `SaveStatus`, `ConflictBanner`,
  draft mirror in `localStorage`, `visibilitychange/pagehide` flush, respect `settings.autosave`.
- **Acceptance (fake-timer unit tests):** typing 5× in 200 ms ⇒ exactly **one** `PUT`; no write for 2 s idle;
  force-flush at 10 s; flush on unmount; backoff schedule exact; `VERSION_CONFLICT` ⇒ conflict state and the
  buffer is retained; "Keep mine" retries with the fresh server `version`; "Use server" replaces the buffer and
  clears the draft mirror; autosave off ⇒ zero automatic writes and the pill says so.
- **Live check (documented in the PR body):** type in two tabs, save in one, observe conflict UI in the other;
  reload immediately after typing and confirm the text is present.
- **Out of scope:** merge/diff UI (a plain three-way merge is backlog `PR-25`).

#### PR-15 — New-note dialog with `new-file-<msepoch>.md` prefill
**Branch:** `feat/pr-15-new-note` · **Size:** S · **Depends on:** PR-12, PR-09

- **Create:** `components/notes/NewNoteDialog.tsx`, `lib/name.ts`, wire `Ctrl/Cmd+N` + "New note" buttons in
  `TopBar`/`StatusBar`/tree context menu.
- **Acceptance:** input pre-filled with `new-file-<Date.now()>.md`, caret placed before `.md`, `.md` rendered as a
  non-editable suffix and stripped from the submitted name; live invalid-name message; collision against the tree
  cache disables Create with "name already used in this folder"; creating in the selected folder; after create,
  the note opens focused in the editor and the URL changes; a second dialog opened within the same millisecond
  still gets a unique name (`uniquify`).
- **Tests:** Vitest for `lib/name.ts` + dialog behavior (prefill, suffix immutability, disabled Create).

#### PR-16 — Settings (autosave toggle, theme, change password) + users API wiring
**Branch:** `feat/pr-16-settings` · **Size:** M · **Depends on:** PR-07, PR-14

- **Create:** `routes/app/settings.tsx`, `routes/settings.routes.ts`, `db/repositories/settings.repo.ts`,
  `features/settings/*`, settings row created on user insert, theme application (`class="dark"` on `<html>`).
- **Acceptance:** toggling autosave off takes effect immediately in the open editor (pill + no debounce writes);
  change-password form validates current password, forces re-login, other sessions invalidated; theme persists
  across reload and respects `system`.
- **Out of scope:** user management UI beyond the API from PR-07.

#### PR-17 — Search UI
**Branch:** `feat/pr-17-search-ui` · **Size:** S · **Depends on:** PR-11, PR-12

- **Create:** `routes/app/search.tsx`, search box in `TopBar` (`Ctrl/Cmd+K` focuses the page link in MVP),
  results list with breadcrumb path + highlighted snippet, keyboard selection, empty/no-result states.
- **Acceptance:** debounce 250 ms, `?q=` in URL (shareable), clicking a result opens the note, snippets escape HTML.

#### PR-18 — Production Docker image + compose + env safety + deploy docs
**Branch:** `feat/pr-18-docker-prod` · **Size:** M · **Depends on:** PR-01…PR-16 (needs a real app; can be
prepared earlier and rebased)

- **Create:** `docker/Dockerfile` (stage 1 build all workspaces with dev deps + `pnpm build`; stage 2
  `node:22-slim`, `pnpm deploy --prod` or `npm ci --omit=dev` pruned install, copy `dist`/`migrations`, copy
  `apps/web/dist` into the server's static path, `USER node`, `EXPOSE 3000`, `ENTRYPOINT
  docker/entrypoint.sh` → `scripts/check-env.ts` → `pnpm db:migrate` → `exec node apps/server/dist/index.js`),
  with `HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch(…/api/healthz)…"`
  — **no `curl`**: `node:22-slim` does not ship it, and installing it in the runtime layer is out of scope, so the
  probe uses Node's built-in `fetch` (see §10).
  `docker/compose.yml` (`db` + `app`, `db` published **only** internally, `app.ports: "${PORT:-3000}:3000"`,
  `depends_on: condition: service_healthy`, named `pgdata` volume, optional `notes-keys` volume for a mounted key
  file, `restart: unless-stopped`, `init: true`, `db` healthcheck via `pg_isready`), `scripts/check-env.ts`,
  `docs/DEPLOY.md`
  (one-port mapping, **exactly how to invoke compose with the env file** (see §15: the stack is started with
  `docker compose --env-file .env -f docker/compose.yml`, because Compose otherwise auto-loads `.env` from
  `docker/`, not the repo root), TLS/reverse-proxy recipe, backups: `pg_dump` + key backup, key-rotation procedure,
  upgrade procedure, troubleshooting table).
- **Acceptance:** `docker compose --env-file .env -f docker/compose.yml up -d` on a clean VM → the `app` container
  reaches `healthy` (`docker inspect --format '{{.State.Health.Status}}'` — this proves the Node `HEALTHCHECK`
  works with no `curl` in the image) → `curl http://localhost:3000/api/healthz` ok **from the host** →
  browser on `:3000` reaches `/setup`, creates the account, and CRUD survives `docker compose … restart`;
  `${PORT}` from the repo-root `.env` is honored in the published port mapping (proves env-file wiring);
  `docker history` shows no dev deps and no `curl`; image runs as uid ≠ 0; boot fails loudly (non-zero) when
  `NOTE_ENCRYPTION_KEY` is missing in production.
- **Out of scope:** Kubernetes manifests, TLS termination (documented only), image registry publishing.

#### PR-19 — Playwright e2e suite + CI e2e job + coverage ratchet
**Branch:** `test/pr-19-e2e` · **Size:** M · **Depends on:** PR-08…PR-18

- **Create:** `apps/web/playwright.config.ts` (webServer: build + start API against a throwaway Postgres DB,
  `NOTE_ENCRYPTION_KEY` from a test-only env file that is gitignored; `.env.test` values are non-secret test
  constants), `e2e/{auth.spec.ts,notes.spec.ts,autosave.spec.ts,folders.spec.ts}`, CI `e2e` job.
- **Scenarios (the MVP acceptance proof):**
  1. first run → `/setup` → owner created → lands on `/app`; sign out → `/login` → sign in.
  2. create folder → create note (assert prefilled `new-file-<ms>.md` and immutable `.md`) → type a heading + a
     toolbar bold → preview shows `<strong>` → **reload the page** → text still there.
  3. rename note → tree shows the new name with `.md`; move note to another folder; tree path updates.
  4. folder with a note → delete without typing name is blocked; typed delete removes both.
  5. autosave: pause 1.5 s after typing, status pill shows `Saved`; toggle autosave off in settings ⇒ pill shows
     `Unsaved changes` until `Ctrl+S`.
  6. two pages, same note ⇒ conflict UI in the stale page, no silent overwrite.
- **Acceptance:** green in CI on `ubuntu-24.04` with the `postgres` service; retries ≤ 1 and the suite is proven
  non-flaky across 3 consecutive runs; coverage thresholds bumped to the values in §14.

#### PR-20 — Documentation & instructions pass (docs-as-code, ADRs, README rewrite)
**Branch:** `docs/pr-20-docs` · **Size:** S · **Depends on:** PR-18 (structure final), PR-19 (verification steps known)

- **Modify:** `README.md` — replace the planning text with: what it is, quick start (Docker one-port), local dev,
  configuration table link, security notes (encryption at rest + key-loss caveat), roadmap link to this plan, and a
  short "what the MVP deliberately does not do" list.
- **Create:** `docs/adr/0001…0005` (one per decision in §4/§5), `docs/ARCHITECTURE.md` (condensed §6–§11 with the
  *as-built* deltas), `docs/API.md` final sweep; **update `AGENTS.md`** with the real commands
  (`pnpm dev/build/lint/typecheck/test/test:integration/coverage`, `make db-up`) and the layout conventions from §7
  (per `AGENTS.md`'s own rule: docs updated in the same PR as the change).
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
| D — Domain API | 09, 10, 11 | 05+07 | strict order 09 → 10 → 11 |
| E — UI | 12, 13, 14, 15, 16, 17 | 08 (+ contract shapes of 09/10) | 12 and 15 overlap: 15 is the small dialog slice, deliberately separable |
| F — Ship | 18, 19, 20 | merge of D+E | sequential |

**Suggested milestones (review gates):**

- **M0** after PR-03: repo is clonable, CI real, `pnpm dev` serves something.
- **M1** after PR-08: a user can set up an account, log in, log out — on a real DB, in Docker, in CI.
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
concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }
jobs:
  quality:      # pnpm lint && pnpm typecheck            (~40 s)
  unit:         # pnpm coverage + artifact              (~60 s)
  integration:  # services: postgres:16 → pnpm test:integration (~2 min)
  build:        # pnpm build && docker build (no push)   (~3 min)
  e2e:          # PR-19: build, start app, Playwright chromium (~4 min)
```

Rules:

- `pnpm install --frozen-lockfile` only; lockfile committed; `cache: pnpm` in `actions/setup-node`.
- Coverage thresholds are declared in each `vitest.config.ts` (not in CI flags) so local runs match CI:

| Scope | lines | functions | branches | statements | after PR-19 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts` | 90 | 90 | 85 | 90 | 95 |
| `apps/server/src/{services,crypto,db}` | 80 | 80 | 75 | 80 | 85 |
| `apps/server/src/routes` | 70 | 70 | 65 | 70 | 80 |
| `apps/web/src/lib` | 80 | 80 | 75 | 80 | 85 |
| `apps/web/src` overall | 55 | 55 | 50 | 55 | 65 |

  Thresholds only ever ratchet upward; a PR that wants to lower one needs a written justification in its body.
- Integration/e2e jobs get a throwaway DB: `POSTGRES_PASSWORD: test` service env, `DATABASE_URL` pointing at it —
  test-only credentials, never real ones (per repo rules, no live secrets in CI files).
- `docker build` job never pushes an image (no registry configured in the MVP).
- Flaky policy: `retries: 1` for e2e only; a test that fails on re-run gets an immediate follow-up issue/PR.

---

## 15. Docker / self-hosting runbook

**Dev** (PR-02): `make db-up` → Postgres 16 on `localhost:5432` in Docker; the app runs on the host with
`pnpm dev` (`tsx watch` API on `:3000`, Vite on `:5173` proxying `/api`).

**Production** (PR-18):

```bash
# 1. generate config in the REPO ROOT (this is the file the app and compose both read)
printf 'NOTE_ENCRYPTION_KEY=%s\n' "$(docker run --rm node:22-slim node -e \
  'console.log(require("crypto").randomBytes(32).toString("base64"))')" > .env
# 2. fill in POSTGRES_PASSWORD / DATABASE_URL / PORT in .env (see §16), then — always from the repo root,
#    and always with BOTH flags (see the note below):
docker compose --env-file .env -f docker/compose.yml up -d     # publishes ONLY ${PORT:-3000}
docker compose --env-file .env -f docker/compose.yml ps        # app reported healthy
# 3. open http://<host>:3000  → /setup → create the first owner
```

> **Why the flags are mandatory.** Compose resolves its *project directory* from the compose file's location, so
> with `-f docker/compose.yml` it auto-loads `.env` from `docker/` — **not** from the repo root. Without
> `--env-file .env`, `${PORT:-3000}`, `POSTGRES_PASSWORD` and the `DATABASE_URL` handed to the app silently fall
> back to defaults/empty. Either always pass `--env-file .env` (recommended, shown above), or keep the file at
> `docker/.env` and say so in `docs/DEPLOY.md`. `docs/DEPLOY.md` and the `Makefile` must use the identical
> invocation; `make` targets wrap it so operators cannot get it wrong. `docker/compose.yml` additionally declares
> `env_file: ../.env` on the `app` service so the container's own environment does not depend on the shell.

- Single published port: `app.ports: ["${PORT:-3000}:3000"]` (set `PORT=8080` in the repo-root `.env` to move the
  host side); `db` has **no** published port.
- Volumes: `pgdata` (Postgres). Optionally mount a key file (`secrets/note-key.txt`) instead of an env var —
  `check-env.ts` supports `NOTE_ENCRYPTION_KEY_FILE`.
- Updates: `git pull && docker compose --env-file .env -f docker/compose.yml build && docker compose --env-file .env
  -f docker/compose.yml up -d` (entrypoint runs migrations first;
  migrations must be backward-compatible within one minor release — documented rule).
- Backups: `docker compose --env-file .env -f docker/compose.yml exec db pg_dump -U notetaker notetaker | gzip > backup.sql.gz`
  **plus the encryption
  key**; restore + `scripts/rotate-note-key.ts` documented in `docs/DEPLOY.md`. Restore drill is part of PR-18's
  acceptance criteria (restore into a scratch compose file and log in).

---

## 16. Configuration reference

`.env.example` (PR-01, extended by PR-06/PR-18). Values shown are safe non-secret defaults.

| Var | Default | Prod required | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | ✔ `production` | enables prod invariants in `check-env.ts` |
| `HOST` | `0.0.0.0` | — | bind address |
| `PORT` | `3000` | — | the one published port |
| `DATABASE_URL` | `postgres://notetaker:notetaker@localhost:5432/notetaker` | ✔ | Postgres DSN |
| `DB_POOL_MAX` | `10` | — | postgres.js pool size |
| `SESSION_TTL_DAYS` | `30` | — | session cookie + DB expiry |
| `SECURE_COOKIES` | `false` (dev) | ✔ `true` behind TLS | `Secure` cookie flag |
| `TRUST_PROXY` | `false` | ✔ if behind a proxy | accurate client IPs for rate limiting |
| `ALLOW_REGISTRATION` | `false` | — | when false, extra accounts come from `POST /api/users` (owner only) |
| `NOTE_ENCRYPTION_KEY` | — | ✔ (32 bytes base64) | current AES-256 key |
| `NOTE_ENCRYPTION_KEY_FILE` | — | alternative | read the key from a mounted file |
| `NOTE_ENCRYPTION_KEY_PREVIOUS` | — | only during rotation | JSON map `{"1": "<base64>"}` |
| `LOGIN_RATE_LIMIT_MAX` | `10` | — | failures per 15 min per user+IP |
| `MAX_NOTE_BYTES` | `1048576` | — | request body / note size cap |
| `LOG_LEVEL` | `info` | — | pino level |
| `APP_NAME` | `Note Taker` | — | title shown in the SPA |

`env.ts` (Zod-parsed) fails fast with a readable list of problems; `scripts/check-env.ts` adds the cross-field
prod rules. **Never** commit a real `.env`; `.gitignore` covers `.env*` except `.env.example`.


---

## 17. Testing & verification strategy

| Layer | Tooling | Command | Lives in | Owner PR |
| --- | --- | --- | --- | --- |
| Pure unit (name rules, markdown transforms, autosave machine, crypto, tree selectors, env parsing) | Vitest + `@testing-library/react` (components) | `pnpm test` / `pnpm coverage` | `*.test.ts(x)` next to sources | every PR |
| API integration (real Postgres, `app.inject()` — no port binding) | Vitest + Drizzle | `pnpm test:integration` | `apps/server/src/{routes,db}/*.test.ts` | PR-04 onward |
| Contract tests | Schemas exercised from both apps; a route that drifts from `contracts` fails typecheck | `pnpm typecheck` | `packages/contracts` | PR-05 |
| e2e (browser, real app, real DB, encryption on) | Playwright chromium | `pnpm test:e2e` | `apps/web/e2e/*.spec.ts` | PR-19 |
| Manual acceptance (only for things automation can see poorly: feel of autosave, preview fidelity) | checklist below | — | PR body screenshots/video | PR-13, PR-14 |

**The MVP proof (must be demonstrated, PR-19):** open the app → set up → create nested folders → create a note
(auto-named) → write Markdown using the toolbar → see the preview → close the tab mid-edit → reopen → the text is
there → the DB contains only ciphertext for that note → rename/move/delete behave → logout/login restores state.

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
| "Backend stores saved notes efficiently & securely. 2 way encrypted?" (L23) | PR-06 envelope crypto, §10 | PR-06 tests + e2e assertion that DB rows are ciphertext |
| "Folders and notes persistence: Raw file system? or database?" (L24) | decided: Postgres — ADR-0001, PR-04 | PR-04 integration tests |
| "Folders and filenames can be renamed" (L25) | PR-09 (`PATCH /api/folders/:id`, `PATCH /api/notes/:id`) + PR-12/PR-15 dialogs | PR-09 tests, e2e #3 |
| "Auto-save can be enabled (default on)" (L26) | PR-14 (engine, default on), PR-16 (setting) | PR-14 unit tests, e2e #5 |
| "File names auto generated as `new-file-<msepoch>.md` … ask for file name … extension not editable" (L27) | `contracts/names.ts` (PR-05), `NewNoteDialog` (PR-15) | PR-05 + PR-15 tests, e2e #2 |
| "Provide a text editor UI producing markdown" (L29) | PR-13 (editor + preview) | PR-13 tests, e2e #2 |
| "'word' style with toolbar **OR** raw markdown + preview" (L30-32) | raw Markdown + toolbar + preview — ADR-0003, PR-13 | PR-13 transform tests; WYSIWYG deferred to PR-22 |

---

## 20. Risks & mitigations

| # | Risk | Impact | Mitigation (owner PR) |
| --- | --- | --- | --- |
| R1 | **Losing `NOTE_ENCRYPTION_KEY` = unrecoverable notes** | Critical, user data | Key backup + restore drill in `docs/DEPLOY.md`; fingerprint logging; `check-env.ts` boot guard (PR-06, PR-18) |
| R2 | Autosave silently overwrites in a second tab | Lost writing | `version` optimistic concurrency + conflict UI (PR-10, PR-14) — never last-write-wins |
| R3 | Browser crash between keystrokes and the debounce window | Small text loss | Draft mirror in `localStorage`, restore prompt, flush on `pagehide` (PR-14) |
| R4 | Cascade folder delete nukes many notes accidentally | Data loss | API requires `cascade=true`; UI requires typing the folder name; hard delete logged (PR-09, PR-12) |
| R5 | In-process search degrades as notes grow | Sluggish UX | 500-candidate cap + recency ordering; documented `pg_trgm`/`tsvector` path (PR-11, PR-29) |
| R6 | Breaking the placeholder `CI.yml` name silently disables Claude reviews | Silent tooling loss | PR-03 keeps `name: CI`; acceptance step verifies the `workflow_run` still fires |
| R7 | Tailwind v4 / CodeMirror API churn | Rework | Pinned versions, thin wrappers (`components/ui`, `lib/markdown.ts`), textarea fallback documented in PR-13 |
| R8 | `pnpm` lockfile not committed → `--frozen-lockfile` fails in CI | Red CI forever | PR-01 commits `pnpm-lock.yaml`; PR-03 uses `--frozen-lockfile` |
| R9 | Two sources of truth if someone adds FS writes later | Corrupt tree | ADR-0001 + `AGENTS.md` rule (PR-20); FS export only as read-only (PR-24) |
| R10 | Session fixation / cookie leak on plain HTTP | Account takeover | Rotation on login, `Secure` behind TLS enforced by `check-env.ts`, `SameSite=Lax` + CSRF token (PR-07, PR-18) |
| R11 | Scope creep (passkeys, WYSIWYG, trash) delaying MVP | Ship risk | §3.2 explicit non-goals + Track G frozen until PR-20 |

---

## 21. Open questions for the product owner

Defaults in §4 are already implemented by the PRs; these only need a *no* to change:

1. **License** — MIT assumed (PR-01 adds `LICENSE`). Prefer ISC/AGPL/none?
2. **Single-owner vs multi-user** — MVP assumes one owner created at `/setup`, extra accounts only via
   `POST /api/users` (`ALLOW_REGISTRATION=false`). Should open registration be the default for a personal box?
3. **Folder delete semantics** — hard delete + typed confirmation (MVP) vs soft-delete/trash (PR-23). Hard delete
   keeps the MVP small; is that acceptable?
4. **Editor** — raw Markdown + toolbar + live preview accepted? If "Word-style" is the *primary* desire, PR-22 must
   be promoted into the MVP (+3–4 days, and PR-13 shrinks).
5. **Unencrypted dev mode** — plaintext allowed only when `NODE_ENV=development`. OK, or should encryption be
   mandatory everywhere?
6. **Port** — `3000` published by default; any host-port convention you want in `docs/DEPLOY.md` (e.g. `8080`)?
7. **Theme/branding** — system light/dark only, or a brand color/font pass? (affects PR-08 tokens)
8. **Password reset** — none in the MVP (no email); recovery = "delete the user row and re-run setup" documented, or
   should an admin reset flow be added (+½ day, PR-16 extension)?
9. **Passkey timing** — confirm PR-21 stays post-MVP (recommended: yes).

---

## Appendix A — concrete implementation sketches

Reference-level only (the PRs own the real code); these pin down the non-obvious parts.

**A.1 Name helper (`packages/contracts/src/names.ts`)** — the README's `new-file-<msepoch>.md` rule lives here and
nowhere else:

```ts
export const MD_EXT = '.md';
export const newFileName = (msEpoch: number = Date.now()) => `new-file-${msEpoch}${MD_EXT}`;
// "Draft.md" -> "Draft" (names are stored extension-free)
export const stripMd = (name: string) => name.toLowerCase().endsWith(MD_EXT) ? name.slice(0, -MD_EXT.length) : name;
export const withMd = (name: string) => stripMd(name) + MD_EXT; // display only
export const isValidNoteName = (name: string) =>
  stripMd(name).length > 0 && stripMd(name).length <= 120 &&
  !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && name === name.trim() && name !== '.' && name !== '..';
export const uniquify = (name: string, taken: Set<string>): string => { /* base-2.md, base-3.md … */ };
```

**A.2 Atomic versioned content write (`notes.repo.ts`)** — one statement, so two tabs cannot both win:

```ts
const updated = await db
  .update(notes)
  .set({ contentCipher, contentIv, keyVersion, contentBytes, wordCount,
         version: sql`${notes.version} + 1`, contentUpdatedAt: new Date(), updatedAt: new Date() })
  .where(and(eq(notes.id, noteId), eq(notes.userId, userId), eq(notes.version, baseVersion)))
  .returning();
if (updated.length === 0) throw new VersionConflictError(noteId);   // route → 409 VERSION_CONFLICT
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

**A.4 Tree in one query (`tree.service.ts`)** — recursive CTE with `user_id` bound once, `depth < 100` guard,
`array_agg` path for breadcrumbs; assembled into `{folders: FolderNode[], notes: NoteNode[]}` and rebuilt into a
nested structure client-side by `features/tree/tree.selectors.ts`.

**A.5 Autosave state machine shape (`lib/autosave.ts`)** — `createAutosaver({debounceMs, maxUnflushedMs, settings,
save})` returning `{ onEdit(), flush(), state: 'clean'|'dirty'|'saving'|'retrying'|'conflict', conflict }`; the hook
only subscribes React to it, which is what makes the 6 behaviors in PR-14 unit-testable without a DOM.

---

*End of plan. Slice tasks in the order of §12/§13; keep this file updated whenever a decision in §4 or the task
list changes.*

