# MVP-10 · PR-10 — Note content read/write with versioning + autosave-safe writes

> **Task ID:** `PR-10` · **Branch:** `feat/pr-10-content-api` · **Size:** M (1–2 days)
> **Depends on:** PR-06, PR-09 (merged) · **Track:** D Domain API (strict order 09 → 10 → 11)
> **Review gate:** M2 · **Unblocks:** PR-11 (search), PR-13/PR-14 (the editor writes through this)

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~22k tokens** | this brief (1.8k as written) + PR-09's `services/note.service.ts`, `routes/notes.routes.ts`, repositories + PR-06's envelope + PR-04's test helpers + `contracts/notes.schemas.ts` (`contentUpdateSchema`) + reading the rotation-race output |
| **Output** | **~8k tokens** | the `PUT /api/notes/:id/content` handler + service method, ETag/If-Match plumbing, the A.2 conditional update, payload-cap config, ~3 `.int.test.ts` files (incl. the rotation race re-test) |
| **Session total** | **~30k tokens** | ≈ one `M` engineer-day; budget ~40k if the `If-Match`/`ETag` semantics need extra iteration |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

The write side of note content: `PUT /api/notes/:id/content` with optimistic concurrency (`baseVersion`), so two tabs
never silently overwrite each other. The read side (`GET /api/notes/:id`) **already shipped in PR-09**; you own
only the write path, and you re-test the `ETag` round-trip against the read.

## 2. Repo state you can assume

- `notes` columns: `version integer NOT NULL DEFAULT 1`, `content_cipher`/`content_iv`/`key_version`,
  `content_bytes`, `word_count`, `content_updated_at`, `updated_at`.
- `crypto/envelope.ts` (`sealNoteContent`/`openNoteContent`) and the keyring from PR-06; notes are always a valid
  envelope (never plaintext, never an empty cipher).
- PR-09's `note.service.ts`, `notes.repo.ts`, `routes/notes.routes.ts`, and `GET /api/notes/:id` returning
  `{…NoteNode, content, version}` with `ETag: W/"v<version>"`.
- `domain/errors.ts` has `VersionConflictError` (PR-05) and the error handler maps it to
  `409 VERSION_CONFLICT`; Postgres `40001`/`40P01` → retryable `CONFLICT`.
- `contracts` has `contentUpdateSchema {content, baseVersion}` and the note schemas.
- Env var `MAX_NOTE_BYTES` (default `1048576`) is parsed by `env.ts`.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-10`; CI green; never lower a coverage threshold; docs updated in the
same PR (`docs/API.md` for the new endpoint); any new column ⇒ migration here (you need none).

## 4. The write must be one atomic statement (Appendix A.2)

```ts
// Drizzle schema properties are camelCase and map to the snake_case columns of PR-04's schema; adjust to db/schema.ts.
const updated = await db
  .update(notes)
  .set({ contentCipher, contentIv, keyVersion, contentBytes, wordCount,
         version: sql`${notes.version} + 1`, contentUpdatedAt: new Date(), updatedAt: new Date() })
  .where(and(eq(notes.id, noteId), eq(notes.userId, userId), eq(notes.version, baseVersion)))
  .returning();
if (updated.length === 0) {
  // The UPDATE also filtered on id + userId, so zero rows means either a stale version
  // or a note that does not exist for this user. Re-read, scoped, to keep the "404, never 403" rule.
  const current = await db
    .select({ contentCipher: notes.contentCipher, contentIv: notes.contentIv,
              keyVersion: notes.keyVersion, version: notes.version })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  if (current.length === 0) throw new NotFoundError(noteId);                    // route → 404 NOT_FOUND
  throw new VersionConflictError(noteId, open(current[0]), current[0].version); // route → 409 + server content
}
```

One statement, so two tabs cannot both win and a process killed mid-request leaves no partial write.

## 5. Required behavior

- Request `{content, baseVersion}`; `If-Match` optional (`If-Match: W/"v<baseVersion>"` when present must agree).
- Success response: `{…NoteNode, content, version: version+1}` with the new `ETag`.
- `baseVersion` mismatch ⇒ `409 VERSION_CONFLICT` **whose body carries the current server `content` and `version`**
  (in the envelope's `error.data`, pinned by PR-05).
  That payload is what lets PR-14's autosave engine tell a committed-but-unacknowledged write from a real collision: the
  client compares the returned content with the exact snapshot it put on the wire, and if they are equal it adopts the
  returned `version` and settles clean instead of showing a phantom conflict. **Pin both fields in an assertion.**
- Unknown id or another user's note ⇒ `404`, **never** `409` (that is what the follow-up scoped read is for).
- Empty-string content is allowed (a legitimately emptied note) and must still store a valid envelope
  (12-byte IV + 16-byte tag).
- Maintain `content_bytes` (plaintext byte length), `word_count`, `content_updated_at`, `updated_at`.
- Body cap **1 MiB** via Fastify `bodyLimit` → `PAYLOAD_TOO_LARGE` (the UI warns at 900 KiB in PR-13).
- `notes.version` increments exactly once per successful write; nothing else bumps it (rotation must not — PR-06's rule).

## 6. Acceptance criteria

- [ ] Two clients on the same version ⇒ one `200`, one `VERSION_CONFLICT` **carrying server `content` + `version`**
      (assert both fields).
- [ ] Empty-string content allowed and readable back as `''`.
- [ ] `PUT` with `If-Match` matching a stale ETag ⇒ `VERSION_CONFLICT`; matching the current one ⇒ `200`.
- [ ] `PUT` against a missing note or another user's note ⇒ `404`, never `409`.
- [ ] Over-cap body (> 1 MiB) ⇒ `PAYLOAD_TOO_LARGE`; ~1 MiB under the cap succeeds.
- [ ] Concurrent writes via `Promise.all` ⇒ exactly one winner, `version` incremented once, no partial write when the
      request is aborted mid-flight (single statement).
- [ ] **Re-test of PR-06's rotation-concurrency guarantee, one layer up:** run `rotate-note-key.ts` (as a `tsx`
      subprocess — the `integration` job builds packages only, never `apps/server/dist`) while a real
      `PUT /api/notes/:id/content` lands mid-rotation ⇒ the note ends with the **client's** content at the current
      `key_version`, `version` bumped exactly once, and the rotation's `--verify` still exits 0.
- [ ] `ETag` round-trip against PR-09's `GET /api/notes/:id`.

## 7. Out of scope

The client autosave engine (PR-14) and any UI, search (PR-11), conflict merge UI (backlog PR-25), idempotency-key
infrastructure (deliberately rejected: the content comparison in the engine answers the same question for free).

## 8. PR body template

```
Task: PR-10

## What
PUT /api/notes/:id/content with single-statement conditional version bump (A.2), scoped re-read → 404 vs
VERSION_CONFLICT (+content,+version), ETag/If-Match, content_bytes/word_count/content_updated_at maintenance,
1 MiB bodyLimit → PAYLOAD_TOO_LARGE.

## Acceptance evidence
- integration run: two-clients race, If-Match stale/current, 404-not-409, 413 at >1 MiB, rotation race re-test (--verify 0)
```
