# MVP-14 · PR-14 — Autosave engine + save status + conflict UX

> **Task ID:** `PR-14` · **Branch:** `feat/pr-14-autosave` · **Size:** M (1–2 days)
> **Depends on:** PR-10, PR-13 (merged) + **PR-09** for the real `settings.autosave` value (the engine itself takes it as
> an **injected** flag, so PR-09 is only needed by the caller)
> **Track:** E UI · **Review gate:** M3 · **Unblocks:** PR-16 · **Reads:** PR-10's `VERSION_CONFLICT` payload
> **ADR:** the idempotency-key rejection and the keepalive-vs-beacon decision are recorded in `docs/ARCHITECTURE.md` (PR-20).

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~24k tokens** | this brief (3.2k as written: the state table and the conflict-fork rules) + PR-13's editor/editor-pane structure + PR-10's conflict payload + PR-09's settings endpoint + `lib/api.ts` CSRF behavior + Vitest fake-timer and mocked-`fetch` patterns |
| **Output** | **~12k tokens** | `lib/autosave.ts` (pure machine), `useAutosave()` hook, `components/editor/{SaveStatus,ConflictBanner}.tsx`, localStorage draft mirror, unload flush, ~3 large unit-test files (fake timers) |
| **Session total** | **~36k tokens** | ≈ one `M` engineer-day; budget ~48k because every row of the state table needs its own test |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

**Autosave on by default, per-user, conflict-safe across tabs.** A pure, unit-testable state machine plus a thin React
hook, a visible status pill, and an explicit conflict UI that never silently overwrites.

## 2. Repo state you can assume

- PR-13's editor page holds a raw Markdown buffer; the save-status pill slot exists (`data-testid="save-status"`).
- PR-10: `PUT /api/notes/:id/content {content, baseVersion}` → `{…NoteNode, content, version:version+1}`;
  `baseVersion` mismatch → `409 VERSION_CONFLICT` **whose body carries the current server `content` and `version`**;
  unknown/other-user id → `404`; over 1 MiB → `PAYLOAD_TOO_LARGE`.
- PR-09: `GET /api/settings` → `{autosave:boolean, theme:string}` (get-or-create, never 404) and
  `PATCH /api/settings`. **PR-16 supplies the UI that flips the flag; you take it as an injected input.**
- `lib/api.ts` (PR-05) injects `X-CSRF-Token` and does a one-shot 403 refresh-and-replay.
- Error codes: `VALIDATION|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|RATE_LIMITED|VERSION_CONFLICT|PAYLOAD_TOO_LARGE|INTERNAL`.
  **Vocabulary:** `VERSION_CONFLICT` is the stale-`baseVersion` code; plain `CONFLICT` is the sibling-name clash. The
  autosave machine **never reacts to plain `CONFLICT`**.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-14`; CI green; never lower a coverage threshold; docs updated in the
same PR.

## 4. The machine (pure, no DOM)

```
clean ──edit──▶ dirty ──debounce 1200ms──▶ saving ──200──▶ clean
                                   └──5xx/transport──▶ retry(backoff 1s,2s,4s,8s,30s) ──▶ saving
saving ──VERSION_CONFLICT──▶ (payload == the snapshot we sent ? clean | dirty : conflict)
                                     conflict ──(user picks)──▶ overwrite | loadServer
```

`createAutosaver({debounceMs, maxUnflushedMs, settings, save})` returning `{ onEdit(), flush(), state, conflict, error }`.

| state | entered when | exits to |
| --- | --- | --- |
| `clean` | buffer equals the last saved content | `dirty` on `onEdit()` |
| `dirty` | an edit landed, debounce running | `saving` when the debounce fires or `flush()` is called |
| `saving` | one `PUT` in flight carrying `baseVersion = v`, **remembering the exact payload it sent** | `clean` (200 ⇒ adopt the returned `version`) · `clean` **or** `dirty` **silently** when a `VERSION_CONFLICT` payload equals that in-flight snapshot (the write landed, the reply was lost) · `conflict` (same error, different content) · `retrying` (5xx/transport) |
| `retrying` | 5xx or transport error | `saving` on the backoff timer; `conflict`/`error` once the retry budget is spent |
| `conflict` | `VERSION_CONFLICT` **whose content differs from the in-flight snapshot** — buffer retained, autosave paused | "Keep mine" ⇒ `saving` with the fresh server `version`; "Use server" ⇒ `clean` |
| `error` | `401` (session gone ⇒ stop autosaving, route to `/login`, the `localStorage` draft mirror keeps the text) · `403` after the one CSRF refresh-and-replay · `404` (note deleted elsewhere ⇒ offer "save as a new note") | manual retry, or `dirty` on the next edit for the 403 case |

**Three rules that make the table safe:** (1) at most **one** request may be in flight; (2) an edit arriving during
`saving` is never dropped and never starts a parallel request — it parks the machine in `dirty`, and the next debounce
window opens when the in-flight request settles, always sending the newest buffer with the newest known `version`;
(3) a `VERSION_CONFLICT` becomes `conflict` **only after** the content comparison in §5 shows the payload differs from
the exact snapshot that request carried. The hook only subscribes React to this machine — that is what keeps every row
unit-testable without a DOM.

## 5. The `VERSION_CONFLICT` fork (not optional — it is what makes retry safe)

A `PUT` the server committed but whose response never arrived (connection reset, proxy `502`/`504`, client timeout) is
indistinguishable, from the client's seat, from a `PUT` that never reached the server. So the retry replays with the old
`baseVersion`, the conditional `UPDATE` matches 0 rows, and a client that treats every conflict as a collision shows the
`ConflictBanner` and pauses autosave on a note whose server content **already equals the buffer** — a phantom conflict
the user cannot resolve except by clicking through their own text.

**Therefore the engine keeps the exact payload it put on the wire** — the in-flight snapshot, *not* a reference to the
live buffer (which a later keystroke would change). Rule: on `VERSION_CONFLICT`, compare the `content` the error carries
(in `error.data`, pinned in PR-05 §6) with that snapshot.

- **Equal** ⇒ the write landed, only the reply was lost ⇒ adopt the payload's `version` and continue with **no banner and
  no pause**: to `clean` if the live buffer still equals the snapshot, to `dirty` if the user typed meanwhile (the next
  debounce then writes the newer buffer against the adopted `version`).
- **Different** ⇒ a real second writer ⇒ `conflict`.

Comparison is on the **plaintext buffer before sealing**, never on ciphertext: the seal is randomized (fresh IV per
write), so two seals of one string are never byte-equal. A per-request idempotency key was considered and rejected for
the MVP (dedupe table + expiry policy, and it still has to answer "same request or new edit?" the moment the user types
during the retry).

## 6. Flush triggers, unload path, and the settings flag

- Debounce **1200 ms**; force-flush at `maxUnflushedMs = 10 000`; `Ctrl/Cmd+S`; note switch; folder rename/move affecting
  the open note; `window blur`; `visibilitychange → hidden` and `pagehide`.
- Unload flush uses `fetch(…, { keepalive: true })` with the normal `PUT` + `X-CSRF-Token` headers.
  **No `navigator.sendBeacon`:** it can only `POST` and cannot set headers, so it cannot carry the CSRF header.
  `keepalive` bodies are capped at ~64 KiB by the browser while notes may reach 1 MiB, so the unload path is bounded:
  - dirty buffer **≤ 60 KiB** (safety margin): best-effort `fetch(keepalive:true)` on `pagehide`;
  - dirty buffer **> 60 KiB**: **no unload write is attempted**; the ≤ 10 s force-flush plus the dirty-guard prompt
    ("Save / Discard / Stay") protect the data and the `localStorage` draft mirror is the crash fallback. The pill shows
    `Unsaved changes` so the user is never told "Saved" for a buffer that could not be flushed.
  A CSRF-exempt beacon endpoint is rejected (a write path the CSRF model does not cover).
- **Every write sends `baseVersion = lastKnownServerVersion`.**
- Draft mirror: buffer mirrored to `localStorage['note-draft:<id>']` so a browser crash keeps the last text, with a
  restore prompt.
- When `settings.autosave === false` (injected): no debounce writes; `Ctrl/Cmd+S` and the explicit Save button still
  work; navigating away with a dirty buffer prompts. The read is get-or-create (PR-07 creates the row with the user,
  PR-09 re-creates it if absent), so a missing settings row can never silently flip autosave.
- `SaveStatus` pill in `StatusBar`: `Saved 12:03:11`, `Saving…`, `Unsaved changes`, `Retrying (2)…`, `Conflict`,
  `Autosave off — Ctrl+S to save`.
- `ConflictBanner`: *Keep mine* / *Use server* / *Copy server text* — never a silent overwrite. Autosave is disabled while
  the machine is in `conflict`.

## 7. Files to create

`apps/web/src/lib/autosave.ts` (pure machine; `autosave: boolean` is an **injected** input, not fetched here),
`useAutosave()` hook, `apps/web/src/components/editor/{SaveStatus,ConflictBanner}.tsx`, the draft-mirror helper,
`features/notes/note.mutations.ts` write wiring, and the unit tests.

## 8. Acceptance criteria (fake-timer unit tests)

- [ ] Typing 5× in 200 ms ⇒ exactly **one** `PUT`; no write for a 2 s idle period.
- [ ] Force-flush at 10 s; flush on unmount; the backoff schedule is exact (1s, 2s, 4s, 8s, 30s).
- [ ] `VERSION_CONFLICT` ⇒ `conflict` state and the buffer is retained; "Keep mine" retries with the fresh server
      `version`; "Use server" replaces the buffer **and clears the draft mirror**.
- [ ] `autosave: false` injected ⇒ zero automatic writes and the pill says so.
- [ ] **Lost-response idempotency (the case that makes retry safe):** a `PUT` whose stub commits server-side and then
      drops the response ⇒ the retry replays the same `baseVersion`, the stub answers `VERSION_CONFLICT` carrying
      **that same content** and a bumped `version` ⇒ the machine goes to **`clean`**, adopts the version, never enters
      `conflict`, renders no `ConflictBanner`, and keeps autosaving.
- [ ] Sibling case proving the fork is not a blanket suppress: the same `VERSION_CONFLICT` carrying **different**
      content ⇒ `conflict`, buffer retained.
- [ ] Third case — the one proving the comparison runs against the in-flight snapshot, not the live buffer: an edit lands
      after the lost response ⇒ the payload still matches the snapshot, so the machine adopts the `version` and lands in
      **`dirty`**, then a second `PUT` writes the newer content — never `conflict`, and nothing typed is lost.
- [ ] Unload path: a 40 KiB dirty buffer on `pagehide` ⇒ exactly one `fetch(…, {keepalive:true})` `PUT` **with the CSRF
      header**; a 200 KiB dirty buffer ⇒ **no** unload request attempted, buffer stays dirty, pill stays
      `Unsaved changes`, dirty-guard prompt fires; `navigator.sendBeacon` is never called (spy on it).
- [ ] **Every row of the state table asserted**, which means at least: an edit landing *while* a `PUT` is in flight ⇒
      still exactly one in-flight request, and a second `PUT` fires afterwards carrying the newest buffer + newest
      `version` (nothing typed is lost, no two writes ever race); `500`/transport ⇒ `retrying` with the documented
      backoff then a terminal state; `401` ⇒ autosave stops, routes to `/login`, the draft mirror still holds the text;
      `403` ⇒ one CSRF refresh + one replay, then surface it; `404` ⇒ the "note deleted elsewhere" state with a
      save-as-new-note escape hatch, never a silent re-create.
- [ ] `apps/web/src/lib` coverage stays ≥ 80/80/75/80 (`lib/autosave.ts` is the biggest file in that scope).

## 9. Live check (document it in the PR body)

Type in two tabs, save in one, observe the conflict UI in the other; reload immediately after typing and confirm the text
is present.

## 10. Out of scope

Merge/diff UI (a plain three-way merge is backlog PR-25), the settings page that flips the flag (PR-16), offline
IndexedDB sync (backlog), note history/versions UI (backlog PR-23).

## 11. PR body template

```
Task: PR-14

## What
lib/autosave.ts pure state machine (debounce 1200ms / force-flush 10s / backoff 1,2,4,8,30 / one in-flight request),
in-flight snapshot comparison for VERSION_CONFLICT, useAutosave(), SaveStatus pill, ConflictBanner
(keep mine / use server / copy server text), localStorage draft mirror, ≤60 KiB keepalive flush on pagehide.

## Acceptance evidence
- fake-timer unit run covering every table row + the three lost-response cases + the unload budget + sendBeacon never called
- two-tab live check (screenshot/GIF): conflict UI in the stale page; reload after typing keeps the text
```
