# MVP task briefs — index

This folder holds the MVP work breakdown as **one self-contained brief per PR**, plus the source plan.

- **`MVP-FULL-PLAN.md`** — the plan of record (requirements, stack, data model, API contract, security model, CI design,
  runbook, config reference, traceability). It stays authoritative for *decisions*.
- **`MVP-01.md` … `MVP-20.md`** — the work orders. Each brief restates the context its PR needs (schema rows, endpoint
  contracts, env vars, CI/coverage rules, acceptance checklist), so **the coding agent running that PR never has to load
  the full plan**. Duplication across briefs is deliberate.

## How to use these

1. Pick the next task whose `Depends on` PRs are already merged (see the table).
2. Hand that one file to the agent as its whole brief; branch name and PR-body format are in the file's header.
3. The agent must satisfy every box in the brief's **Acceptance criteria** section before the PR is ready for review.
4. If a PR changes a decision, update `MVP-FULL-PLAN.md` **and** the affected brief(s) in the same PR — the same-PR docs
   rule in `AGENTS.md` applies to the plan too.

## Task index

| Brief | PR | Task | Branch | Size | Depends on | Input est. | Output est. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [`MVP-01.md`](MVP-01.md) | PR-01 | Monorepo scaffold, tooling, hello-world app | `feat/pr-01-scaffold` | M | — | ~22k | ~11k |
| [`MVP-02.md`](MVP-02.md) | PR-02 | Local dev infra (Postgres in Docker, Make) | `chore/pr-02-dev-infra` | S | 01 | ~15k | ~3.5k |
| [`MVP-03.md`](MVP-03.md) | PR-03 | Real CI (replaces the placeholder workflow) | `ci/pr-03-real-ci` | M | 01 | ~14k | ~3k |
| [`MVP-04.md`](MVP-04.md) | PR-04 | DB schema, migrations, repository harness | `feat/pr-04-db-schema` | L | 01, 02 | ~26k | ~13k |
| [`MVP-05.md`](MVP-05.md) | PR-05 | Shared contracts (Zod DTOs, envelope, typed client) | `feat/pr-05-contracts` | M | 01 | ~28k | ~14k |
| [`MVP-06.md`](MVP-06.md) | PR-06 | Envelope encryption + key management + rotation | `feat/pr-06-encryption` | M | 04, 05 | ~25k | ~10k |
| [`MVP-07.md`](MVP-07.md) | PR-07 | Auth core (sessions, cookies, CSRF, rate limit) | `feat/pr-07-auth-api` | M | 04, 05 | ~27k | ~15k |
| [`MVP-08.md`](MVP-08.md) | PR-08 | Auth UI + session context + UI kit v1 | `feat/pr-08-auth-ui` | M | 05, 07 | ~23k | ~11k |
| [`MVP-09.md`](MVP-09.md) | PR-09 | Folders & notes CRUD API + tree + settings + seed | `feat/pr-09-notes-api` | L | 05, 06, 07 | ~31k | ~19k |
| [`MVP-10.md`](MVP-10.md) | PR-10 | Note content read/write with versioning | `feat/pr-10-content-api` | M | 06, 09 | ~22k | ~8k |
| [`MVP-11.md`](MVP-11.md) | PR-11 | Search API | `feat/pr-11-search-api` | M | 10 | ~18k | ~6k |
| [`MVP-12.md`](MVP-12.md) | PR-12 | App shell + folder tree UI | `feat/pr-12-tree-ui` | L | 08, 09 | ~25k | ~17k |
| [`MVP-13.md`](MVP-13.md) | PR-13 | Markdown editor pane + toolbar + preview | `feat/pr-13-editor` | L | 12, 10 | ~25k | ~15k |
| [`MVP-14.md`](MVP-14.md) | PR-14 | Autosave engine + save status + conflict UX | `feat/pr-14-autosave` | M | 10, 13 (+09) | ~24k | ~12k |
| [`MVP-15.md`](MVP-15.md) | PR-15 | New-note dialog (`new-file-<msepoch>.md`) | `feat/pr-15-new-note` | S | 12, 09, 13 | ~16k | ~5k |
| [`MVP-16.md`](MVP-16.md) | PR-16 | Settings UI (autosave, theme, change password) | `feat/pr-16-settings` | M | 07, 09, 14 | ~19k | ~7k |
| [`MVP-17.md`](MVP-17.md) | PR-17 | Search UI | `feat/pr-17-search-ui` | S | 11, 12, 13 | ~16k | ~5k |
| [`MVP-18.md`](MVP-18.md) | PR-18 | Production Docker + compose + env safety + deploy docs | `feat/pr-18-docker-prod` | M | 01…17 | ~27k | ~11k |
| [`MVP-19.md`](MVP-19.md) | PR-19 | Playwright e2e + CI `e2e` job + coverage ratchet | `test/pr-19-e2e` | M | 08…18 | ~23k | ~9k |
| [`MVP-20.md`](MVP-20.md) | PR-20 | Docs pass (README, ADRs, ARCHITECTURE) | `docs/pr-20-docs` | S | 18, 19 | ~24k | ~13k |

**Totals:** ≈ **660k tokens** of session traffic for the whole MVP (**~450k input + ~208k output**, summed across the
table) — i.e. roughly **14k–31k input and 3k–19k output per PR**. Each brief is only **1.1k–5.2k tokens**, versus
**~50k** for `MVP-FULL-PLAN.md`, which is the point of the split: the rest of the input estimate is the merged code, tool
docs, and the agent re-reading its own output. Estimates assume the agent works from its single brief plus the merged code
it touches, uses `pnpm add` rather than hand-editing `pnpm-lock.yaml`, and lands within one or two verification loops;
treat them as ±30% planning numbers, not a budget. Sizes (`S` ≤ ½ day, `M` = 1–2 days, `L` = 3–4 days) remain the
schedule unit.

## Execution order

Sequential-safe order (always valid): `01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 16 →
17 → 18 → 19 → 20`.

Parallel tracks (from the plan §13; the briefs' `Depends on` lines are authoritative):

| Track | PRs | Can start once | Notes |
| --- | --- | --- | --- |
| A — Foundation | 01 → (02, 03) | — | 02 and 03 are independent of each other |
| B — Data & contracts | 04, 05, 06 | 01 / 02 | **05 has zero DB dependency — do it immediately after 01**; it unblocks 06…17 |
| C — Auth | 07, 08 | 04 + 05 | 08's UI can be built against contract mocks while 07 lands |
| D — Domain API | 09, 10, 11 | 05 + 06 + 07 | strict order 09 → 10 → 11 |
| E — UI | 12, 13, 14, 15, 16, 17 | 08 (+ shapes of 09/10) | 12 and 15 overlap; 15 is the small separable dialog slice |
| F — Ship | 18, 19, 20 | merge of D + E | sequential |

Extra edges the ASCII graph in the plan compresses: **PR-15 and PR-17 also need PR-13** (their acceptance ends inside the
note editor); **PR-14 needs PR-09** (the settings API); **PR-16 needs PR-09 + PR-14**; **PR-09 needs PR-06** (its
`POST /api/notes` seals content and `GET /api/notes/:id` decrypts it).

**Acceptance must stay acyclic too:** a PR's tests may only exercise code that exists when it merges. If a criterion
needs a route from a later PR, it lives in that later PR (which is why PR-06 asserts crypto at the module layer while
PR-09/PR-10 carry the HTTP-level versions).

## Review gates

| Gate | After | What must be true |
| --- | --- | --- |
| M0 | PR-03 | repo clones, CI real, `pnpm dev` serves something |
| M1 | PR-08 | setup → login → `/welcome` → logout on a real DB, in Docker, in CI |
| M2 | PR-11 | the whole domain drivable over the API with tests |
| M3 | PR-17 | the product usable end-to-end in a browser |
| M4 | PR-20 | **MVP**: one `docker compose up`, e2e-proven, documented |

## Merge-conflict hotspots

`apps/server/src/app.ts` (route registration), root `package.json` scripts, `apps/server/src/db/schema.ts`,
`apps/web/src/components/ui/*`, `apps/web/src/styles/globals.css`. Convention: **add-only edits** in those files, one
route module per PR.

## Post-MVP backlog (do not start before PR-20 merges)

PR-21 passkeys/WebAuthn · PR-22 WYSIWYG · PR-23 trash/undo + version history UI · PR-24 FS-style export/import ·
PR-25 three-way merge UI · PR-26 tags/pinning/drag-and-drop/palette · PR-27 attachments · PR-28 multi-user sharing/ACLs ·
PR-29 `pg_trgm`/`tsvector` over an encrypted search index · PR-30 backup automation + metrics.
