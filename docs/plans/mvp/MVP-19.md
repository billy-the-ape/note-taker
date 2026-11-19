# MVP-19 · PR-19 — Playwright e2e suite + CI `e2e` job + coverage ratchet

> **Task ID:** `PR-19` · **Branch:** `test/pr-19-e2e` · **Size:** M (1–2 days) · **Depends on:** PR-08…PR-18 (merged)
> **Track:** F Ship · **Review gate:** M4 · **Unblocks:** PR-20
> **This PR is the MVP acceptance proof** — `docs/plans/mvp/MVP-FULL-PLAN.md` §17's "MVP proof" scenario is
> executed by these specs.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~23k tokens** | this brief (2.4k as written: the 7 scenarios + the at-rest assertions) + the `data-testid`s PR-08/12/13/14/15/16/17 left behind + PR-01's env rules + PR-04's `postgres` driver version + PR-06's `key_version` semantics + PR-18's compose/env wiring + Playwright config docs + flaky-run logs |
| **Output** | **~9k tokens** | `apps/web/playwright.config.ts`, `e2e/{auth,notes,autosave,folders}.spec.ts`, `e2e/db.ts`, root `test:e2e` script, the CI `e2e` job, the ratcheted thresholds in both coverage configs |
| **Session total** | **~32k tokens** | ≈ one `M` engineer-day; budget ~45k if a spec needs de-flaking (the suite must pass 3 consecutive runs) |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

Prove the product in a real browser against the **compiled** app and a throwaway Postgres, add the CI `e2e` job, and
ratchet every coverage threshold to the post-PR-19 column.

## 2. Repo state you can assume

- PR-18's image/compose exist; the server serves the built SPA on one port (`plugins/static-spa.ts`); migrations run at
  boot; `GET /api/healthz` is the probe.
- Every UI PR left `data-testid` hooks on the elements its tests assert: `tree`, `folder-row-<id>`, `note-row-<id>`,
  `new-folder`, `rename-dialog`, `move-dialog`, `delete-confirm`, `delete-confirm-name-input`, `editor`,
  `editor-toolbar`, `preview`, `mode-split|write|preview`, `save-status`, `new-note` dialog fields, `search-input`,
  `search-results`, `settings-autosave-toggle`, `sign-out-everywhere`, … If one is missing, **add it in this PR** (the
  rule from the testing strategy: `data-testid` on everything a UI test needs).
- `notes` columns: `content_cipher bytea NOT NULL`, `content_iv bytea NOT NULL` (12 bytes), `key_version integer`.
  `apps/server` depends on **`postgres` (postgres.js)** at a pinned version.
- pnpm does **not** expose one workspace's dependencies to another.
- CI jobs today: `quality`, `unit`, `build` (with `docker build`), `integration`. No `e2e`.
- Coverage thresholds today: `packages/contracts` 90/90/85/90, `apps/server/src/{crypto,domain}` 80/80/75/80,
  `apps/server/src/{services,db,routes}` 80/80/75/80 (integration job), `apps/web/src/lib` 80/80/75/80,
  `apps/web/src` 55/55/50/55.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-19`; CI green; **this PR raises thresholds — never lowers one**;
docs updated in the same PR if commands change (`AGENTS.md`/`README.md` gain `pnpm test:e2e`).

## 4. Files to create

- **`apps/web/playwright.config.ts`** — `webServer` builds and starts the **compiled** API against a throwaway Postgres:
  `NODE_ENV=test node apps/server/dist/index.js`. The inline mode matters: a `webServer` inheriting an unset `NODE_ENV`
  dies on the boot guard before any spec runs. `NOTE_ENCRYPTION_KEY` is a **non-secret test constant supplied as job env
  in CI** — and, for local runs only, via a gitignored `.env.test` carrying that same throwaway value.
- **`apps/web/e2e/{auth.spec.ts,notes.spec.ts,autosave.spec.ts,folders.spec.ts}`**.
- **`apps/web/e2e/db.ts`** — a test-only Postgres reader for scenario 7, written against **`postgres` (postgres.js), the
  driver the stack already uses**, **not** a second `pg` client. Because pnpm does not expose one workspace's deps to
  another, declare `postgres` as a **devDependency of `apps/web` at the version PR-04 pinned**, so the assertion cannot
  drift onto a different driver and nothing production-facing gains a DB client. Playwright specs run in Node, so it
  connects directly to the same throwaway `notetaker_test` DSN the `webServer` is given. It is **read-only** and is never
  imported by app code.
- **The root `test:e2e` script** — the one the CI `e2e` job invokes. PR-01's script list deliberately left it out because,
  like `coverage:integration` in PR-04, a script is registered by the PR that creates the config and specs it runs.
- **The CI `e2e` job**: `ubuntu-24.04`, a `postgres:16` service, `pnpm build`, `pnpm exec playwright install --with-deps
  chromium`, `apps/web/dist` + the API in one job, `retries: 1` (e2e only), `NOTE_ENCRYPTION_KEY` as job env.

## 5. The scenarios (the MVP acceptance proof)

1. **auth** — first run → `/setup` → owner created → lands on `/app`; sign out → `/login` → sign in.
2. **notes** — create folder → create note (assert the prefilled `new-file-<ms>.md` and the immutable `.md`) → type a
   heading + a toolbar bold → preview shows `<strong>` → **reload the page** → text still there.
3. **rename/move** — rename note → tree shows the new name **with `.md`**; move the note to another folder; the tree path
   updates.
4. **typed delete** — folder with a note → deleting without typing the name is blocked; typed delete removes both.
5. **autosave** — pause 1.5 s after typing (deliberately past the 1200 ms debounce) ⇒ the status pill shows `Saved`;
   toggle autosave off in settings ⇒ the pill shows `Unsaved changes` until `Ctrl+S`.
6. **conflict** — two pages, same note ⇒ conflict UI in the stale page, no silent overwrite.
7. **at-rest ciphertext** — the DB leg of the MVP proof, and the only place the README's "encrypted" requirement is
   checked end-to-end: after scenario 2's body has saved, read that note's row through `e2e/db.ts` and assert the typed
   marker string appears **nowhere** in `content_cipher` (compared **as raw bytes**, since it is `bytea`), that
   `content_cipher` is non-empty, that `content_iv` is **exactly 12 bytes**, and that `key_version` equals the current
   `NOTE_ENCRYPTION_KEY_VERSION`. Then re-save an **unchanged** body and assert the ciphertext **changed** — the fresh
   per-write IV — which is what stops this scenario from passing by comparing a stored copy of the plaintext. It also
   asserts the accepted opposite: `notes.name` stays plaintext on purpose (the documented search limitation), so a reader
   of this spec sees **both** halves of the guarantee instead of one of them silently.

## 6. Coverage ratchet (both configs)

After this PR, **both** coverage configs use the post-PR-19 column:

| Scope | lines | functions | branches | statements | enforced by (job · config) |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts` | 95 | 95 | 95 | 95 | `unit` · `packages/contracts/vitest.config.ts` |
| `apps/server/src/{crypto,domain}` | 85 | 85 | 85 | 85 | `unit` · `apps/server/vitest.config.ts` |
| `apps/server/src/{services,db,routes}` | 85 | 85 | 85 | 85 | **`integration`** · `apps/server/vitest.integration.config.ts` |
| `apps/web/src/lib` | 85 | 85 | 85 | 85 | `unit` · `apps/web/vitest.config.ts` |
| `apps/web/src` overall | 65 | 65 | 65 | 65 | `unit` · `apps/web/vitest.config.ts` |

Thresholds live in the Vitest config that produces the number, never in CI flags. If a scope cannot meet its ratchet,
**add tests — do not lower the number** (lowering one needs written justification in the PR description, which this PR
must not need).

## 7. Acceptance criteria

- [ ] Green in CI on `ubuntu-24.04` with the `postgres` service.
- [ ] **Scenario 7 may not be skipped or marked `fixme`** — it is the row the plan cites for "DB rows are ciphertext" and
      the MVP proof's DB leg; a run where it does not execute is a **red build**.
- [ ] `retries: 1` and the suite is **proven non-flaky across 3 consecutive runs** (paste the three run links).
- [ ] `pnpm test:e2e` works locally against the throwaway DB and the gitignored `.env.test` (and `.env.test` is not
      committed).
- [ ] The `webServer` starts the **compiled** entry (`node apps/server/dist/index.js`) with `NODE_ENV=test` — not `tsx`,
      not Vite dev.
- [ ] `e2e/db.ts` uses `postgres` (postgres.js) at PR-04's pinned version, read-only, and no app code imports it.
- [ ] The ratcheted thresholds are applied to **both** the unit `pnpm coverage` configs and the `integration` job's
      `pnpm coverage:integration` config, and CI is green at the new numbers.
- [ ] Scenarios 1–6 assert through `data-testid`s (add any missing hook rather than selecting by brittle structure).

## 8. Out of scope

Visual regression, mobile viewports, accessibility audits as a gate (the a11y rules are enforced by the component tests),
load/perf tests beyond the existing p95 search assertion, merge/diff UI flows (backlog PR-25), passkey flows (backlog
PR-21).

## 9. PR body template

```
Task: PR-19

## What
apps/web/playwright.config.ts (compiled API + throwaway Postgres, NODE_ENV=test), e2e/{auth,notes,autosave,folders}.spec.ts,
e2e/db.ts (postgres.js devDep at PR-04's pin, read-only), root test:e2e, CI e2e job (retries:1), coverage ratchet to the
post-PR-19 column in BOTH coverage configs.

## Acceptance evidence
- three consecutive green e2e runs (links)
- scenario 7 transcript: marker absent from content_cipher (raw bytes), iv length 12, key_version == current,
  re-save of an unchanged body changes the ciphertext, name stays plaintext
- pnpm coverage + coverage:integration green at 95/85/85/85/65
```
