# MVP-17 · PR-17 — Search UI

> **Task ID:** `PR-17` · **Branch:** `feat/pr-17-search-ui` · **Size:** S (≤ ½ day)
> **Depends on:** PR-11, PR-12, PR-13 (merged) — a search result must open the note, and the note route belongs to PR-13
> **Track:** E UI · **Review gate:** M3 (**this PR closes M3**: the product is usable end-to-end in a browser)

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~16k tokens** | this brief (1.1k as written) + PR-11's search endpoint + PR-12's `TopBar`/shell + PR-13's editor focus model and CodeMirror keymap + PR-05's `lib/api.ts`/`queryClient.ts` |
| **Output** | **~5k tokens** | `routes/app/search.tsx`, a `TopBar` search box + global chord handler, result list component, ~2 test files |
| **Session total** | **~21k tokens** | ≈ half an engineer-day (`S`); the chord-precedence test is the only fiddly part |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

`/app/search` with a shareable `?q=`, a `TopBar` entry point, and a `Ctrl/Cmd+K` chord that never fights the editor's own
`Ctrl/Cmd+K` link insertion.

## 2. Repo state you can assume

- Server (PR-11): `GET /api/search?q=&limit=` → `{results:[{noteId,name,folderPath,snippet,score}]}` — ≤ 25 results,
  name hit > body hit > recency, ~120-char snippets from plaintext, empty `q` ⇒ `VALIDATION`.
- Shell (PR-12): `routes/app/route.tsx` layout + `TopBar`/`StatusBar`/`Sidebar`, `data-testid` conventions.
- Editor (PR-13): `routes/app/note.$noteId.tsx`, CodeMirror with an editor-scoped keymap where `Cmd/Ctrl+K` inserts a
  link **while the editor has focus**.
- `contracts`: `searchQuerySchema`, `searchResultSchema`, `ROUTES`.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-17`; CI green; never lower a coverage threshold; docs updated here if
documented behavior changes.

## 4. Files to create

`apps/web/src/routes/app/search.tsx`, a search box/link in `components/layout/TopBar.tsx`, the results list (breadcrumb
folder path + highlighted snippet), keyboard selection (↑ ↓ `Enter`), and empty / no-result states.

`data-testid`s for PR-19: `search-input`, `search-results`, `search-result-<noteId>`, `search-empty`.

## 5. Behavior — including the two chord rules

- Debounce **250 ms**; `?q=` lives in the URL (shareable, and a pasted URL runs the search on load).
- Clicking a result opens the note (`/app/note/<noteId>`).
- Snippets are rendered **escaped** — never `dangerouslySetInnerHTML`; highlight the match by wrapping the matched range
  in a React node.
- **`Ctrl/Cmd+K` is editor-scoped against shell-scoped.** While the CodeMirror editor has focus, its keymap owns the chord
  and inserts a link there; the shell's global handler must **check whether the editor is focused before acting**, so
  search-focus never fires mid-edit and link insertion never leaves the editor. In the MVP the chord focuses the
  search **page link** (a command palette is backlog).
- **`Ctrl/Cmd+N` stays unbound** (browser-reserved — see PR-15). Do not add a handler.

## 6. Acceptance criteria

- [ ] Debounce 250 ms (fake timers: 5 keystrokes in 200 ms ⇒ one request).
- [ ] `?q=` in the URL; loading a URL with `?q=` runs the search; the query survives navigation within the page.
- [ ] Clicking a result opens that note.
- [ ] Snippets escape HTML (`<script>` in a body renders as text, not markup).
- [ ] Empty state, no-result state, and the server error state (e.g. an over-long query) all render distinctly.
- [ ] **Chord precedence asserted both ways:** with the editor focused, `Ctrl/Cmd+K` inserts a link and does **not**
      focus the search link; with focus anywhere else, it focuses the search link without touching any buffer.
- [ ] Keyboard selection in the results list (↑ ↓ `Enter`).
- [ ] Coverage unchanged or better.

## 7. Out of scope

Command palette (backlog PR-26), search operators/filters, `pg_trgm`/`tsvector` (backlog PR-29), highlighting options,
searching folder names as a separate result type (results are notes; `folderPath` is the breadcrumb).

## 8. PR body template

```
Task: PR-17

## What
routes/app/search (?q= shareable, 250ms debounce), TopBar search entry + global Ctrl/Cmd+K guarded by editor-focus check,
results list with breadcrumb + escaped snippet highlight, keyboard selection, empty/no-result/error states.

## Acceptance evidence
- vitest run: debounce, URL round-trip, escaped snippets, chord precedence both directions
```
