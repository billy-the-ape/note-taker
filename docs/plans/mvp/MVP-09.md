# MVP-09 · PR-09 — Folders & notes CRUD API + tree + settings API + seed script

> **Task ID:** `PR-09` · **Branch:** `feat/pr-09-notes-api` · **Size:** L (3–4 days)
> **Depends on:** PR-05, PR-06, PR-07 (merged; schema from PR-04). **PR-06 is a hard dependency** because
> `POST /api/notes` must seal content — even the empty string — and `GET /api/notes/:id` must decrypt it.
> **Track:** D Domain API (strict order 09 → 10 → 11) · **Review gate:** M2 · **Unblocks:** PR-10, PR-12, PR-14, PR-15, PR-16

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~31k tokens** | this brief (3.9k as written: endpoint subset, tree/lock/depth rules, acceptance list) + PR-04's `schema.ts`/repositories/helpers + PR-05's contracts (`tree/notes/folders/settings.schemas.ts`, `names.ts`, `domain/errors.ts`, `error-handler.ts`) + PR-06's `crypto/{envelope,keys}.ts` + drizzle recursive-CTE + Postgres advisory-lock docs |
| **Output** | **~19k tokens** | 3 repositories (finished), `services/{folder,note,tree,settings}.service.ts`, `routes/{tree,folders,notes,settings}.routes.ts`, `domain/name.ts`, `scripts/seed-demo.ts`, `db:seed` script, ~10 `.int.test.ts` files (the cycle-race and depth-cap tests are the big ones) |
| **Session total** | **~50k tokens** | ≈ one `L` engineer-day; budget ~65k — the four-folder disjoint-lock race and the 99-deep tree assertions routinely need extra iterations |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

The whole domain over HTTP: tree read, folder create/rename/move/delete with cycle and depth safety, note
create/rename/move/delete (content sealed), the settings API, and a demo seed. **No UI, no content-versioning endpoint
(PR-10), no search (PR-11).**

## 2. Repo state you can assume

- Schema (PR-04): `folders(id,user_id,parent_id NULL=root,name)` with
  `folders_unique_sib (user_id, COALESCE(parent_id,'0000…0'), name)`;
  `notes(id,user_id,folder_id NULL=root,name,version,content_cipher,content_iv,key_version,content_format,content_bytes,word_count,content_updated_at)`
  with `notes_unique_sib`; `settings(user_id PK, autosave, theme)`.
  **The FKs do not carry `user_id`** — `notes.folder_id → folders.id` and `folders.parent_id → folders.id` — so a target
  folder id from another user is reachable at the SQL level unless the service scopes the lookup.
- `crypto/envelope.ts` exports `sealNoteContent()` / `openNoteContent()` (AES-256-GCM, AAD `note:<uuid>`, always a
  12-byte IV + 16-byte tag, never an empty cipher) and `crypto/keys.ts` a keyring (PR-06).
- `contracts` gives `createNoteSchema`, `renameMoveSchema`, `noteSchema`, `createFolderSchema`, `patchFolderSchema`,
  `deleteOptionsSchema`, `folderNodeSchema`, `noteNodeSchema`, `treeResponseSchema`, `settingsSchema`,
  `patchSettingsSchema`, `names.ts` (`isValidNoteName`, `stripMd`, `withMd`, `newFileName`, `uniquify`), `ROUTES`.
- `domain/errors.ts` + `plugins/error-handler.ts` exist (created in PR-05). **Here they only gain mapping cases**
  (name clash ⇒ `CONFLICT`, cross-user ⇒ `NOT_FOUND`) — never re-create them.
- `test/{helpers/db.ts,helpers/app.ts,fixtures.ts}` (one `owner`, one `member`) and `vitest.integration.config.ts`
  (`include: ['src/**/*.int.test.ts']`) drive everything below.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-09`; CI green; never lower a coverage threshold; any new column ships
with a migration here (you should need none); docs updated in the same PR (`docs/API.md` sections for the new endpoints;
`docs/DATA-MODEL.md` if the depth cap or lock semantics need noting).

## 4. Endpoints

| # | Method + path | Success | Rules |
| --- | --- | --- | --- |
| 12 | `GET /api/tree` | `{folders:[FolderNode], notes:[NoteNode]}` | metadata only, **no content**; one recursive CTE; ordered folders-then-notes, `name` collation `C` |
| 13 | `POST /api/folders` `{name, parentId\|null}` | `201 FolderNode` | 409 sibling clash (body carries the existing `id`); `VALIDATION` naming the cap if the folder would sit at depth 100 |
| 14 | `PATCH /api/folders/:id` `{name?, parentId?}` | `200 FolderNode` | rename and/or move; cycle guard ⇒ `CONFLICT`; same depth cap |
| 15 | `DELETE /api/folders/:id?cascade=true` | `204` | without `cascade=true` and non-empty ⇒ `CONFLICT` |
| 16 | `POST /api/notes` `{name?, folderId\|null, content?}` | `201 NoteWithContent` | no `name` ⇒ generate `new-file-<msepoch>` then `uniquify`; `content` omitted ⇒ `seal('')`; duplicate name in folder ⇒ `CONFLICT` **with the existing id** |
| 17 | `GET /api/notes/:id` | `{…NoteNode, content, version}` + `ETag: W/"v<version>"` | **created here, not in PR-10**; decrypts |
| 19 | `PATCH /api/notes/:id` `{name?, folderId\|null}` | `200 NoteNode` | rename/move (`folderId: null` = root); `notes.name` stays extension-free |
| 20 | `DELETE /api/notes/:id` | `204` | hard delete |
| 22 | `GET /api/settings` · `PATCH /api/settings` | `Settings` | **lands here, not in PR-16** (PR-14 needs the flag and PR-16 depends on PR-14, so PR-16 would be circular) |

`PUT /api/notes/:id/content` (#18) is **PR-10** — do not add it.

## 5. Behavior you must implement

### 5.1 Tree in one query

`GET /api/tree` = a recursive CTE with `user_id` bound once, a `depth < 100` runaway guard, and `array_agg` for the
breadcrumb path; assembled into `{folders: FolderNode[], notes: NoteNode[]}` (the client rebuilds the nesting in
`features/tree/tree.selectors.ts`, PR-12). The `depth < 100` guard protects against a corrupted `parent_id` cycle — it is a
**runaway belt, never a silent truncation**, because the create/move cap below guarantees no legal folder sits where the
CTE stops walking.

### 5.2 Depth cap = 100 levels (an error, not a truncation)

Root folders are depth 0; legal folders occupy depths 0…99. Any create or move that would put a folder below depth 99
answers `VALIDATION` naming the cap.

- **Create:** needs only the destination parent's depth — the same upward ancestor walk used by the cycle guard.
- **Move:** must also measure what it carries: **`depth(newParent) + 1 + height(moved subtree) ≤ 99`**, the height coming
  from a **downward** recursive walk from the moved folder. The upward walk alone would pass a whole deep subtree
  re-parented under a shallow root and drop its tail below the CTE's guard.

### 5.3 Every folder mutation takes one advisory lock per user

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('folder_move'), hashtext(user_id::text));
-- ancestor-walk cycle check + depth checks + the write
COMMIT;
```

Row locks on the two affected folders are **not** sufficient: two moves can lock disjoint pairs (`X` under `Y` while `Z`
under `W`, with `Y ⊂ Z` and `W ⊂ X`), each ancestor walk passes against committed state, and a four-node cycle commits.
Because a move takes exactly **one** advisory lock, the opposite-order acquisition that makes Postgres abort one side of
an `A↔B` pair with `40P01` cannot occur. A `40001`/`40P01` from any other path maps to a retryable `CONFLICT` (PR-05's
error handler already does this), never `INTERNAL`.

### 5.4 Ownership on ids that arrive in **bodies**

Cross-user id in any path, query **or body** ⇒ `404 NOT_FOUND`. A `folderId`/`parentId` pointing at another user's folder
is caught by the service's **scoped lookup** (load the target folder `WHERE id = $1 AND user_id = $2` before
insert/move). Never an FK-violation `500`, never `403` (no existence oracle). Otherwise user A could attach rows into
user B's tree, probe folder ids through FK violations, and lose rows in B's cascade delete. (A composite
`(user_id, id)` unique + FKs is the backlog alternative; do not do it here.)

### 5.5 Names

`POST /api/notes` with no `name` generates `new-file-<Date.now()>` (extension-free) then `uniquify` against siblings.
Sibling clash ⇒ `CONFLICT` carrying the existing `id` (so a double-clicked "Create" ends with one row). `notes.name`
never carries `.md` — `stripMd` in `contracts`, wrapped by `domain/name.ts` server-side; display adds it back.
Folder names: same character/length rules, no extension handling.

### 5.6 Notes are always a valid envelope

`POST /api/notes` always seals through `crypto/envelope.ts`: `seal(content ?? '')`, so a content-less create stores a real
12-byte IV + 16-byte tag and `openNoteContent()` never sees empty columns.

### 5.7 Settings

`settings.service.get()` is **get-or-create**: `INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO
NOTHING`, then select — so a user that predates or bypasses PR-07's transaction (PR-04's raw-insert fixtures, the seed,
a hand-restored row) reads the defaults instead of a 404, and `PATCH` can never match zero rows. The **row itself** is
created by PR-07 in the same transaction as every `users` insert.

### 5.8 Seed script

`scripts/seed-demo.ts`: idempotent demo user + sample tree, guarded by `NODE_ENV !== 'production'`, wired to a new
`pnpm db:seed` script — **`NODE_ENV=development tsx scripts/seed-demo.ts`**, the inline mode required so
`loadDevEnvFile()` and `databaseUrl()` are actually active when it runs. This is the earliest point at which a seed can
hash a password (PR-07) and write real `folders`/`notes` rows. It calls `loadDevEnvFile()` + `databaseUrl()` itself; it
never builds its own DSN.

## 6. Files to create / modify

**Create:** `db/repositories/{folders,notes,settings}.repo.ts` (final forms — folders/notes started in PR-04),
`services/{folder,note,tree,settings}.service.ts`, `routes/{tree,folders,notes,settings}.routes.ts`,
`domain/name.ts`, `scripts/seed-demo.ts`, `apps/server/src/{routes,services}/**/*.int.test.ts`.
**Modify:** `domain/errors.ts` + `plugins/error-handler.ts` (mapping cases only), `apps/server/src/app.ts`
(add-only route registration), root + `apps/server` `package.json` (`db:seed`), `docs/API.md`.

Merge-conflict hotspots: `apps/server/src/app.ts`, root `package.json` scripts, `db/schema.ts`. Convention: **add-only
edits** in those files, one route module per PR.

## 7. Acceptance criteria (integration; ≥ 25 assertions)

- [ ] Every behavior above is covered, plus: 3-level nesting; rename into an occupied sibling name; move folder `A` under
      its own child `B` rejected; cascade delete removes nested folders and their note rows (and content rows).
- [ ] **Root works both ways:** create with `folderId: null` and move a note back to root both work.
- [ ] **A 99-deep chain renders complete** through `GET /api/tree` — every folder and note present, nothing truncated at
      the CTE's `depth < 100` guard.
- [ ] **The cap is an error, not a silent drop:** `POST /api/folders` under the deepest folder answers `VALIDATION`
      naming the limit; **and** the case a destination-depth check alone cannot see — root folder `F` whose subtree
      reaches depth 99 moved under a **different root** folder `R`: the upward walk finds `R` at depth 0, yet `F`'s tail
      would land at depth 100, so the subtree-height check rejects it and the tree is byte-identical afterwards.
- [ ] **Cross-user body-id cases the FKs cannot catch:** user A and user B each create a folder, then B sends
      `POST /api/notes {folderId: A's}`, `POST /api/folders {parentId: A's}`, `PATCH /api/folders/:id {parentId: A's}`,
      `PATCH /api/notes/:id {folderId: A's}` — every call answers `404 NOT_FOUND`, nothing is created or moved, and A's
      subtree is byte-identical afterwards (no FK-violation `500`, no existence oracle).
- [ ] **Move-cycle race — two cases, not one.**
      (a) *Adjacent pair, started as siblings:* `A` and `B` **both at root**, then `PATCH /api/folders/A {parentId: B}` and
      `PATCH /api/folders/B {parentId: A}` through `Promise.all`. Each move is legal alone and illegal together, so
      "exactly one commit lands, the other answers `CONFLICT`" is meaningful. (Start them nested — `B` inside `A` — and the
      first request is rejected by the plain cycle check without any locking, which tests nothing.) Afterwards the
      `GET /api/tree` walk must terminate and both folders stay reachable.
      (b) *Disjoint locks — the case (a) does not catch:* four folders with `Y ⊂ Z` and `W ⊂ X`, fired as
      `PATCH /api/folders/X {parentId: Y}` and `PATCH /api/folders/Z {parentId: W}` concurrently. The first re-parents `X`
      under `Y` (chain `X→Y→Z`), the second re-parents `Z` under its own descendant `W` (`Z→W→X`); together that closes
      `X→Y→Z→W→X`, exactly the pair a design that locks only the moved folder plus its new parent lets through. (Moving
      `W` instead of `Z` — `PATCH …/W {parentId: Z}` — only re-parents `W` and leaves a legal tree, so it cannot be this
      test.) With the per-user advisory lock the second transaction waits, then its walk sees the committed state and
      answers `CONFLICT`. Assert neither interleaving leaves a cycle, exactly one write lands in each case, and the loser
      gets `CONFLICT` — never an unmapped `40P01`/`INTERNAL`.
- [ ] **Route-level crypto assertions live here, not in PR-06** — this is the first PR that makes them measurable:
      `POST /api/notes` with no content stores a real envelope and `GET /api/notes/:id` answers `content: ''`; and a row
      whose ciphertext fails authentication (forced by rewriting the stored blob directly) makes `GET /api/notes/:id`
      answer `INTERNAL` with the note id logged and **never** blank-or-garbage content.
- [ ] **Settings for a user with no row** (the state PR-04's raw-insert fixtures are in): `GET /api/settings` answers the
      defaults with `200` — never 404, never an empty body — and leaves exactly one `settings` row behind, which a second
      `GET` reads back; `PATCH /api/settings {autosave:false}` on such a user updates **one** row and returns the new
      value (so the zero-row update is asserted impossible here rather than discovered by PR-14's toggle or PR-16's page).
- [ ] `pnpm db:seed` is idempotent (run twice ⇒ same row counts) and refuses in `production`.
- [ ] `GET /api/tree` returns metadata only — a note body never crosses the wire in the tree payload.

## 8. Coverage

`apps/server/src/{services,db,routes}` ≥ 80 lines / 80 functions / 75 branches / 80 statements, measured by
**`pnpm coverage:integration`** in the `integration` job (the only job with a Postgres service). It reaches 85% only
after PR-19 ratchets the thresholds. Unit configs must keep excluding `**/*.int.test.ts`.

## 9. Out of scope

Content-versioning endpoint (PR-10), search (PR-11), any UI (PR-12+), soft delete/trash (backlog PR-23),
composite `(user_id, id)` FKs (backlog), `pg_trgm`/`tsvector`.

## 10. PR body template

```
Task: PR-09

## What
tree/folders/notes/settings repositories + services + routes, domain/name.ts, per-user pg_advisory_xact_lock folder
mutations, 100-level cap (create depth + move depth+1+height), scoped body-id lookups → 404, seeded notes sealed
(content ?? ''), settings get-or-create, scripts/seed-demo.ts + pnpm db:seed.

## Acceptance evidence
- integration run (≥25 assertions): depth cap both directions, 99-deep tree complete, cross-user body-id matrix,
  cycle races (a) adjacent pair and (b) disjoint four-node, cascade delete, route-level crypto (empty string + tamper → INTERNAL)
- settings get-or-create assertions; db:seed idempotence + production refusal
- coverage:integration ≥80% on {services,db,routes}
```
