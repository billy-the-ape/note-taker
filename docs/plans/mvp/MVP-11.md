# MVP-11 · PR-11 — Search API

> **Task ID:** `PR-11` · **Branch:** `feat/pr-11-search-api` · **Size:** M (1–2 days) · **Depends on:** PR-10 (merged)
> **Track:** D Domain API (strict order 09 → 10 → 11) · **Review gate:** M2 (closes M2) · **Unblocks:** PR-17 (search UI)

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~18k tokens** | this brief (1.7k as written) + PR-09's services/repositories + PR-06's `openNoteContent()` + `contracts/search.schemas.ts` + drizzle `ILIKE`/`sql` templating docs + timing output from the 1 000-note fixture |
| **Output** | **~6k tokens** | `services/search.service.ts`, `routes/search.routes.ts`, one `.int.test.ts` (plus a 1 000-note fixture helper), `docs/API.md` addition |
| **Session total** | **~24k tokens** | ≈ one `M` engineer-day (the p95 assertion is the only fiddly part) |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

`GET /api/search?q=&limit=` over note **names** (SQL) and decrypted **bodies** (in-process) — deliberately cheap and
in-process, which is acceptable at MVP scale (thousands of notes). Bodies are encrypted, so Postgres full-text is not an
option; that trade-off is the accepted ADR-0002 consequence.

## 2. Repo state you can assume

- Notes store `name` (plaintext, extension-free), `content_cipher`/`content_iv`/`key_version`,
  `content_bytes`, `word_count`, `content_updated_at`. **Names, folder paths, timestamps and sizes are intentionally not
  encrypted** so listings and search metadata work without mass decryption.
- `crypto/envelope.ts`'s `openNoteContent()` decrypts (and throws on tamper — never return blank/garbage).
- `folders` gives the breadcrumb path for results; `test/fixtures.ts` + `test/helpers/db.ts` build users/rows; the
  `integration` job runs `*.int.test.ts` against a real Postgres.
- `contracts` has `searchQuerySchema` and `searchResultSchema` (`{noteId,name,folderPath,snippet,score}`).

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-11`; CI green; never lower a coverage threshold
(`{services,db,routes}` stays ≥ 80% lines via `pnpm coverage:integration`); `docs/API.md` updated here.

## 4. Required behavior

- **Name / folder-path match in SQL:** `ILIKE` on `lower(name)` **with `%` and `_` escaped** so they are literal
  (`\` is escaped too, being the escape character). The folder half matches a **segment** of the breadcrumb — one
  folder name — rather than the `/`-joined path: `/` is a forbidden name character (`docs/NAME-RULES.md`), so a query
  containing it should match nothing instead of every note under some folder. This branch tests the whole corpus,
  though it returns at most **500 matching rows** — and `ORDER BY name_matched DESC, content_updated_at DESC` is what
  keeps that bound from dropping a name hit in favour of 500 newer folder matches (PR-11 review); the ordering is
  part of the contract, not an optimization. It is also **accent-sensitive** (see the Unicode rule below).
- **Name / path / body match in-process:** load up to **500** most recently updated notes for the user, decrypt, and match
  the name, the folder path and the body case-insensitively (substring/word). This pass is what makes results
  accent-aware, and it is also where a name hit is distinguished from a body hit for scoring.
- **Ordering / score:** `name hit > body hit > recency`.
- **Return ≤ 25 results**, each with an **~120-char snippet** generated from **plaintext**, truncated on a
  **code-point boundary** (never split an emoji or surrogate pair).
- **Unicode:** accent folding for search keys — NFD normalize then strip combining marks — applied to both the query and
  the candidate text **inside the in-process pass only**. It cannot run in the SQL branch: `unaccent` is not installed
  (PR-04's migration enables `pgcrypto` alone) and folding is not expressible as an `ILIKE` pattern. Net behavior to state
  in `docs/API.md`: `cafe` finds a note named `café` whenever that note is inside the 500-candidate window, and only the
  exact `café` matches outside it. Making name search uniformly accent-insensitive needs a folded generated column or
  `unaccent` — backlog PR-29, not this PR.
- Everything is scoped to `auth.userId` **inside the repository**, so cross-user results are structurally impossible.
- Empty `q` ⇒ `VALIDATION` (400) via `searchQuerySchema`.
- Cap `limit` (default 25) and never let a caller force more than the 500-candidate scan implies.

## 5. Files

**Create:** `apps/server/src/services/search.service.ts`, `apps/server/src/routes/search.routes.ts`,
`apps/server/src/{services,routes}/search.int.test.ts` (+ a 1 000-note fixture helper in `src/test/fixtures.ts`).
**Modify:** `apps/server/src/app.ts` (add-only route registration), `docs/API.md`. (Two statements were unavoidable
in `db/repositories/notes.repo.ts` — `searchNotesByMetadata` and `listRecentNotesForSearch`, both joining
`folders.repo.ts`'s new `folderPathCte` — because "scoped to `auth.userId` inside the repository" and "the folder
path is SQL's breadcrumb walk" are both rules about the statement, not about a caller.)

## 6. Acceptance criteria (integration)

- [ ] Unicode + accent folding (NFD-strip) asserted **on the in-process path, both directions**: an in-window note named
      `café` is found by `cafe`, and an in-window note whose body says `café` is found by `cafe`.
- [ ] The documented asymmetry is pinned by its own test: for a note **outside** the 500-candidate window, `cafe` finds
      nothing by name while the exact `café` still matches — proof that the SQL branch is accent-sensitive (the gap
      backlog PR-29 closes), so nobody later "fixes" it by silently adding `unaccent`.
- [ ] `%` and `_` in the query are treated **literally** (searching `100%` does not match everything).
- [ ] Empty `q` ⇒ `VALIDATION`; whitespace-only `q` behaves the same way.
- [ ] Cross-user isolation: nothing from another user appears, and the snippet never leaks another user's text.
- [ ] A name hit outranks a body hit; equal scores order by `content_updated_at DESC`.
- [ ] ≤ 25 results returned even when more match; the 500-candidate cap is honored (assert the scan bound, e.g. the
      501st most-recent note is not searched).
- [ ] Snippet is ~120 chars, contains the match, and truncation never splits a code point (test an emoji/CJK boundary).
- [ ] **p95 of a 1 000-note fixture search < 300 ms** (measured in the integration job; log the number in the PR body).
- [ ] A tampered ciphertext row does not crash the search: skip it and log the note id (never blank garbage, never a
      500).

## 7. Out of scope

`pg_trgm` / `tsvector` (documented as the scale-out path in ADR-0002, backlog PR-29 — only needed past ~5 000 notes), an
encrypted search index, `unaccent` or a folded generated column for accent-insensitive **SQL** name search (same backlog
item; the in-process pass already covers the common case), search UI (PR-17), pagination beyond `limit`.

## 8. PR body template

```
Task: PR-11

## What
GET /api/search: SQL name/path match (escaped ILIKE, accent-sensitive) + in-process name/path/body match over
≤500 recent notes, score name>body>recency, ≤25 results, ~120-char code-point-safe snippets, NFD accent folding applied
in-process (documented in docs/API.md together with the out-of-window asymmetry).

## Acceptance evidence
- integration run: unicode folding (in-window, both directions), the pinned out-of-window asymmetry, literal %/_ ,
  empty q → VALIDATION, cross-user isolation, cap bounds, snippet safety
- measured p95 over the 1 000-note fixture: <n> ms (<300)
```
