# API reference

The prose version of plan [§9](plans/mvp/MVP-FULL-PLAN.md#9-api). The machine-readable half is the
[`@note-taker/contracts`](../packages/contracts/src) package, which **both apps import**:
[`routes.ts`](../packages/contracts/src/routes.ts) holds every path, the schema files hold every
body/query/response shape, and [`api-envelope.ts`](../packages/contracts/src/api-envelope.ts) holds the
error contract. That shared import is what keeps the two sides in step — a path or a field renamed in the
package stops compiling in an app that missed the rename — and `json({ schema })` in the client re-checks a
response body against the schema it names. Nothing generates this file and no CI job diffs it against the
routes: it is maintained by hand, and `AGENTS.md` requires it to change in the same PR as the contract it
describes.

> **Status.** Everything below is implemented except `GET /api/search` (**PR-11**): `apps/server` serves rows 1–20
> and 22 today, and the "Lands in" column says which PR put each one there. The UI PRs (**PR-08**,
> **PR-12…PR-17**) only consume it. An unknown path answers the envelope with `NOT_FOUND`, which is the shape every
> route keeps.

## Conventions

| | |
| --- | --- |
| Base path | `/api` (`API_BASE_PATH`). In development Vite proxies `/api` to the API process, so the SPA calls the same paths with no configuration. |
| The SPA | The API process serves the built client too (**PR-12**), so one port is the whole product — that is the README's "assign it a port" requirement. `apps/server/src/plugins/static-spa.ts` registers `@fastify/static` on `apps/web/dist` **only when that directory holds an `index.html`**, which keeps a bare clone and a DB-only deployment working: with no build the process answers `/api/*` and nothing else. When there is a build, `GET /` and every path in the plugin's `SPA_SHELL_ROUTES` — `/app` and its subtree, plus the top-level client routes `/login`, `/setup` and `/signup`, so a bookmark or a reload of the sign-in page is the app rather than a JSON envelope — answer `index.html` with `Cache-Control: no-cache` (a stale shell is the whole app, forever), `assets/*` answer with a year of `immutable` (Vite's filenames are content hashes), and everything else 404s — never with a shell, so a missing bundle fails in the network log instead of painting a blank page, and so `/login/anything` stays a mistake a crawler can branch on. The fallback is one `wildcard: false` route per listed path rather than a catch-all on purpose: `@fastify/static`'s default prefix matching would take over every non-`GET` request whose path starts with a served path, and `/api/*` is never in the fallback's business, so an unknown `/api` path keeps answering the envelope above. |
| Content type | `application/json; charset=utf-8` both ways. Requests use `UTF-8` explicitly so the 1 MiB body cap is measured in bytes on the way in, not in characters. Two doors, and a client has to tell them apart: a body that is JSON but breaks the route's schema is `400 VALIDATION`, while a body the transport will not parse (any content type with no registered parser, e.g. a `text/plain` form post) is refused before routing with `415`, which keeps its status and carries `VALIDATION` because `apiErrorCodeForStatus(415)` is deliberately undefined (**PR-09**). Neither ever answers `INTERNAL`, and neither writes a row. |
| Auth | The `HttpOnly` `note_session` cookie (plan §10). "Auth: yes" below means a valid session is required; `GET /api/auth/session` answers with `{ user: null }` instead of failing. Guards run in one order: the CSRF hook is an app-wide `onRequest`, so a mutation that has **neither** a session nor a valid `X-CSRF-Token` is refused `403 FORBIDDEN` and never reaches the session check — `401 UNAUTHORIZED` therefore means "the token half was fine; the session is not". A signed-out browser recovers from the `403` by refetching `GET /api/auth/status` for a fresh pair (which is not a credential and is handed to anybody), which is why `apps/web/src/lib/api.ts` treats `403` as refresh-and-replay-once and `401` as route-to-sign-in. |
| CSRF | Every mutation (`POST`/`PUT`/`PATCH`/`DELETE`) carries `X-CSRF-Token`, echoing the non-`HttpOnly` `note_csrf` cookie (`Max-Age` 1 day, shorter than the session). `GET /api/auth/status` issues it, and every `setup`/`login`/`register`/`logout` response re-issues a fresh one, so it is never older than the browser session carrying it. `login`/`setup`/`register` are exempt (`CSRF_EXEMPT_ROUTES`) and guarded by `Origin`/`Sec-Fetch-Site` instead (**PR-07**). The pair is deliberately **not** bound to a `sessions` row: double-submit equality plus the origin check is what does the binding in a single-instance MVP. The origin a request is measured against is the API's own `protocol` + `Host`; with `TRUST_PROXY=true` the `X-Forwarded-Host`/`X-Forwarded-Proto` pair wins (its **last** value), because a proxy that rewrites `Host` — nginx's default `proxy_set_header Host $proxy_host`, and this repo's own dev proxy until PR-07's review — would otherwise answer every same-origin browser mutation with `403`. `apps/web/vite.config.ts` therefore pins `changeOrigin: false`, and a proxy in front of a deployed instance has to pass `Host` through or send both forwarded headers. Trusting the forwarded host is not a blanket pass: an `Origin` that differs from it is still refused. |
| Payload cap | 1 MiB request body (Fastify `bodyLimit`) → `PAYLOAD_TOO_LARGE` (413). The UI warns at 900 KiB. It is one app-level cap (`MAX_NOTE_BYTES`, `apps/server/src/app.ts`) rather than a per-route one, so a note cannot be written past it by any route; the schema refuses an over-cap `content` too, which is the door an internal caller — one that reaches the service without a transport — meets instead (**PR-10**). |
| Concurrency | `GET /api/notes/:id` answers `ETag: W/"v<version>"`, and `PUT /api/notes/:id/content` answers the new one with its `200`. `If-Match` on that write is **optional**: absent means the body's `baseVersion` decides on its own, `*` means "whatever is there", and a tag naming a version other than the one being written against refuses the request without writing — as `VERSION_CONFLICT` (or `404`), never as a `412` this API has no code for. Both halves of that precondition are bounded by the same `int4` ceiling (`MAX_NOTE_VERSION`), so neither can carry a number the version column could never hold (**PR-10**). |
| Timestamps | ISO-8601 UTC strings (`isoDateTimeSchema`), i.e. what `JSON.stringify(new Date())` produces. |
| Ids | UUIDv7 strings. |
| Lists | `{ items, total, limit, offset }` (`paginatedSchema()`), `limit` ≤ 100, default 50 — except the tree and search, which have their own shapes below. |

## The error envelope

Every non-2xx response, **including a path that matches no route**:

```jsonc
{
  "error": {
    "code": "CONFLICT", // API_ERROR_CODES
    "message": "name already exists in this folder", // human-readable, never a stack or a driver message
    "details": [{ "path": "name", "message": "must be unique among siblings" }], // field errors
    "data": { "id": "0f6f0c1a-0000-4000-8000-000000000000" }, // code-specific payload, §Data below
    "requestId": "req-1" // matches the x-request-id header and the server log line
  }
}
```

`code` and `message` are always present; `details`, `data` and `requestId` are omitted rather than sent
as `null`. The SPA's `ApiError` (`apps/web/src/lib/api.ts`) carries all five fields, and a body that is
not an envelope (a proxy page, a gateway error) still becomes an `ApiError` with the code that fits the
status.

| `code`              | HTTP | Means                                                                                     |
| ------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `VALIDATION`        | 400  | Bad input, or a request that cannot be answered as sent                                     |
| `UNAUTHORIZED`      | 401  | No or expired session → the SPA routes to sign-in                                           |
| `FORBIDDEN`         | 403  | Signed in, not allowed (role, ownership, registration closed)                               |
| `NOT_FOUND`         | 404  | No such route, or no such row **for this user** (never a 403: no id probing)                |
| `CONFLICT`          | 409  | State clash: sibling name, non-empty folder, duplicate create; retryable by the client      |
| `VERSION_CONFLICT`  | 409  | The versioned-write guard failed; `data` carries the current server `content` + `version`   |
| `RATE_LIMITED`      | 429  | Login rate limit or `auth_attempts` lockout; carries `Retry-After` (**PR-07**)              |
| `PAYLOAD_TOO_LARGE` | 413  | Over the 1 MiB cap                                                                          |
| `INTERNAL`          | 500  | A bug. `message` is `internal error`; the real failure is in the log against `requestId`    |

Status is **not** the discriminator: `CONFLICT` and `VERSION_CONFLICT` share 409, and clients branch on
`code`. Postgres `40001` (serialization failure), `40P01` (deadlock) and `23505` (unique violation) map
to `CONFLICT`/409 rather than an unexplained 500 — all three are retryable, and a client that saw 500
would not retry.

Three more mappings arrived with the tree endpoints, and each exists because the alternative would be a status
code a client could act on wrongly (**PR-09**):

* **`23503` (foreign-key violation) → `NOT_FOUND`/404.** Every id that arrives in a *body* — `folderId` on a note,
  `parentId` on a folder — is looked up scoped to the caller before anything is written, so the constraint is
  already unreachable through an ordinary request; what is left is the parent being deleted in the instant between
  that check and the insert, which is exactly the state the same request would have described a moment later. A
  `500` there would report the database's internals as the caller's emergency, and — worse — a `500` for someone
  else's id next to a `404` for a made-up one is an existence oracle for other people's uuids.
* **An `EnvelopeError` → `INTERNAL`/500 with the note id in the log line and the generic message on the wire.**
  The stored ciphertext failed to authenticate, so the plaintext is unrecoverable; the failure text names key
  versions and fingerprints (which a client cannot act on), and the one body a client might misread as success is
  `content: ""` — an empty note it would then feel safe overwriting. The operator needs to know *which* row, so
  the id is attached to the log, next to the `requestId` the envelope already carries.
* **A folder create or move that would exceed 100 levels → `VALIDATION`/400**, with `details[].path` of `parentId`
  — always that field, because it is the only field that can ask for more depth than the tree has — and a message
  that states the cap and the depth it would have produced. Nothing is silently truncated: a tree that cannot be
  built is refused, because a folder quietly dropped at level 101 is data the user can neither see nor delete.
  **A note never produces this error**, in either direction: notes are leaves, so creating one or moving one cannot
  deepen the tree, and the folder it lands in was already within the cap. A note whose `folderId` is unknown or
  belongs to someone else is the `404` above. There is no depth `VALIDATION` carrying `details[].path` of
  `folderId` for a client to write handling for.

One number a client may act on is not in the body: a `429` from a rate limit carries `Retry-After` in whole
seconds — the time the sliding window itself reports — and nothing else writes that header. The envelope above
has nine codes and no retry shape, so the seconds stay a header instead of becoming a field only one endpoint
had (**PR-07**). Two properties of the window are worth stating where a client reads about it: it counts
**attempts**, and a slot is taken synchronously when the request arrives rather than when its outcome is known,
so `N` simultaneous guesses cannot all pass the gate and then all be verified; and it counts **failed** logins
as failures only in the sense that a successful login gives the whole window back, so one mistyping person at a
shared address cannot lock the household out of the account next door.

The two `data` shapes plan §9.1 pins:

```jsonc
{ "error": { "code": "CONFLICT", "message": "…", "data": { "id": "the row that won the race" } } }
{ "error": { "code": "VERSION_CONFLICT", "data": { "content": "current server content", "version": 7 } } }
```

The first exists so a double-clicked "Create" ends with one note (the client adopts the winner);
PR-14's autosave engine compares the second with the snapshot it sent before it calls anything a
conflict (plan §11.4).

`docs/NAME-RULES.md` covers the name rules those `details` entries report.

## Endpoints (plan §9.2)

| # | Method + path | Auth | Request | Success | Lands in |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /api/health`, `GET /api/healthz` | none | — | `200 {status:'ok', db:'ok', version}`, or `503 {status:'error', db:'error', version}` when the pool does not answer | **PR-05** (the DTO) + **PR-04** (a real `SELECT 1`; the probe is not a placeholder any more) |
| 2 | `GET /api/auth/status` | none | — | `{needsSetup, registrationOpen}` | **PR-07** (issues `note_csrf`; `registrationOpen` mirrors the operator's flag and is not conditioned on `needsSetup`) |
| 3 | `POST /api/auth/setup` | none, only while `needsSetup` | `registerSchema` | `200 {user}` + cookie | **PR-07** (`409 CONFLICT` once an owner exists — including a different username, where `users_one_owner_uidx` is the guard rather than the `needsSetup` read) |
| 4 | `POST /api/auth/register` | none, only when registration is open **and** an owner exists | `registerSchema` | `201 {user}` + cookie | **PR-07** (`403 FORBIDDEN` when `ALLOW_REGISTRATION=false` **or** when no owner exists yet: an install with zero owners would lock `/setup` out; `429` + `Retry-After` after `LOGIN_RATE_LIMIT_MAX` attempts per **address** — a username-keyed window would be evaded by renaming every request — and a taken username is `409` plus a failed `auth_attempts` row) |
| 5 | `POST /api/auth/login` | none | `loginSchema` | `200 {user}` + `note_session` | **PR-07** (`401 UNAUTHORIZED` for an unknown username and a wrong password alike, one message; `429` + `Retry-After` after `LOGIN_RATE_LIMIT_MAX` **attempts** per `lower(username)`+IP — the slot is taken as the request arrives, not when it fails, so a burst cannot slip through) |
| 6 | `POST /api/auth/logout` | yes | — | `204` | **PR-07** (deletes the row; the cleared cookie alone would be replayable from a request that never sends cookies) |
| 7 | `POST /api/auth/logout-all` | yes | — | `204` | **PR-07** (used by PR-16; deletes every session of the caller) |
| 8 | `GET /api/auth/session` | optional | — | `{user\|null, expiresAt?}` | **PR-07** (`expiresAt` only with a user; an expired row is deleted on the request that proves it is dead) |
| 9 | `POST /api/auth/password` | yes | `changePasswordSchema` | `204` | **PR-07** (`401 UNAUTHORIZED` when `currentPassword` is wrong or the acting session vanished; `400 VALIDATION` when the new secret breaks §10 — too short, over 512 bytes, or **equal to the account's own username** ignoring case, which the body schema refuses before argon2 runs, since the username it is checked against comes from the session and not from the body). The acting session is rotated and kept, every other session of that user is deleted, and the old password stops working — one transaction, so a failure at any of the three statements leaves the old password and every session exactly as they were) |
| 10 | `POST /api/users` | owner | `createUserSchema` | `201 {user}` | **PR-07** (no `role` in the body, so this route can never mint a second owner; creates no session for the new account) |
| 11 | `GET /api/users` | owner | — | `usersResponseSchema` (`{users: SessionUser[]}`) | **PR-07** (the whole list, oldest first, unpaginated) |
| 12 | `GET /api/tree` | yes | — | `treeResponseSchema` (metadata, **no content**) | **PR-09** (two flat lists, folders then notes, each ordered by `name collate "C"` then `id` so a `C` and an `en_US.utf8` cluster answer the same way; one recursive CTE for the folders and one flat select for the notes, so the payload is never an N+1; a note body never crosses this wire, and a 99-deep chain renders complete) |
| 13 | `POST /api/folders` | yes | `createFolderSchema` | `201 FolderNode` | **PR-09** (the root is an explicit `parentId: null`, never `""`; a sibling already holding the name is `409 CONFLICT` with `data.id` of the winner; the 101st level is `400 VALIDATION` naming the 100-level cap rather than a silent truncation; takes the per-user advisory lock, as do 14 and 15) |
| 14 | `PATCH /api/folders/:id` | yes | `patchFolderSchema` | `200 FolderNode` | **PR-09** (rename and/or move in one request, applied as **one** `UPDATE` so the sibling index judges the `(parent, name)` the caller asked for rather than a half-applied pair; a no-op rename, and a move to the parent it is already in, are success rather than a conflict; moving a folder under its own descendant is `409`, while a move whose subtree would land below the cap is `400 VALIDATION` with `details[].path` of `parentId` — which a destination-depth check alone cannot see; two concurrent moves of one user serialize, one commits and one answers `409`) |
| 15 | `DELETE /api/folders/:id` | yes | query `cascade=true` (`folderDeletePath()`) | `204` | **PR-09** (without `cascade`, a folder with child folders or notes answers `409 CONFLICT`; with it, one `DELETE` and `ON DELETE CASCADE` take the subtree and every note in it; the row is the caller's or the answer is `404`, and the same sentence answers a row that never existed) |
| 16 | `POST /api/notes` | yes | `createNoteSchema` | `201 NoteWithContent` | **PR-09** (every field optional: no body is a valid note, so the server generates `new-file-<msepoch>` — stored extension-free — and seals the empty string, which is a real envelope and never empty cipher/iv columns; `folderId` is looked up scoped to the caller first, so another user's folder is `404`, not a `500` about a foreign key; a request with **no body at all** is that same request and is valid — the route defaults it, because Fastify hands the handler `undefined` when no `Content-Type` was announced — whereas a request that declares `application/json` and sends an empty body is refused by the transport itself, with the same `VALIDATION` code) |
| 17 | `GET /api/notes/:id` | yes | — | `NoteWithContent` + `ETag: W/"v<version>"` | **PR-09** (the tag is weak on purpose — the validator is a version counter, not a hash of bytes a server that cannot read the plaintext could compute. A stored body whose GCM tag does not verify answers `500 INTERNAL` with the note id in the log, **never** `content: ""`, which a client would happily overwrite) |
| 18 | `PUT /api/notes/:id/content` | yes | `contentUpdateSchema` | `200 NoteWithContent` (`version:version+1`) + `ETag: W/"v<new version>"` | **PR-10** (the versioned write, and the read side #17 is PR-09: `baseVersion` is compared, never trusted, and `version + 1` happens in the **same** `UPDATE` as the new envelope, so two tabs holding one version cannot both win and a request killed mid-flight leaves no half-written note. A stale `baseVersion` is `VERSION_CONFLICT` carrying `data.content` and `data.version` — the server's current body and version, which PR-14's autosave compares with the exact snapshot it sent before it calls anything a conflict. The write filters on `user_id` too, so a note that is missing **or** somebody else's is re-read scoped and answered `404`, never the `409` that would confirm the row (and its content) exists. `If-Match` is optional and honoured when present (see Concurrency above); an empty `content` is legal and still stores a real envelope, and `content_bytes`/`word_count`/`content_updated_at` move with the body — the only endpoint that moves `version` at all. `baseVersion` is bounded by `MAX_NOTE_VERSION`, the `int4` ceiling of the column it is compared against: a body naming a version past it is `400 VALIDATION` on `baseVersion`, not a Postgres `22003` that `mapError()` can only report as `500`) |
| 19 | `PATCH /api/notes/:id` | yes | `renameMoveSchema` | `200 NoteNode` | **PR-09** (rename and/or re-file in one request, applied as **one** `UPDATE` inside one transaction, so the sibling index judges the `(folder, name)` the request asked for and never a half-applied pair — and a move whose destination already holds the name is `409 CONFLICT` carrying that row's id; `folderId: null` moves to the root and a name that still ends in `.md` is stripped once on the way in; `version` is untouched, so renaming never invalidates an open editor) |
| 20 | `DELETE /api/notes/:id` | yes | — | `204` | **PR-09** (hard delete of the row and its envelope; a second delete answers `404`) |
| 21 | `GET /api/search?q=&limit=` (`searchPath()`) | yes | — | `searchResponseSchema` | PR-11 |
| 22 | `GET /api/settings`, `PATCH /api/settings` | yes | `patchSettingsSchema` | `Settings` | **PR-09** (get-or-create: a caller with no row reads the column defaults with `200` and leaves exactly one row behind, which the next `GET` reads back, so PR-16 has no "settings missing" state to render; `PATCH` ensures the same row, so it can never be a zero-row write reported as success, and it is partial but never empty) |

## Examples

### `POST /api/notes` — 201

```jsonc
// → { "name": "Draft.md", "folderId": null, "content": "" }   // name is stripped before it is stored
// ← 201 (NoteWithContent)
{
  "id": "0198…", "name": "Draft", "folderId": null, "version": 1,
  "contentBytes": 0, "wordCount": 0, "content": "",
  "contentUpdatedAt": "2026-11-19T09:00:00.000Z",
  "createdAt": "2026-11-19T09:00:00.000Z", "updatedAt": "2026-11-19T09:00:00.000Z"
}
```

`name` omitted means the server generated `new-file-<msepoch>` and uniquified it; `content` omitted
means an empty sealed note, never empty cipher/iv columns.

### the same call again — 409, with the winner

```jsonc
// ← 409
{ "error": { "code": "CONFLICT", "message": "name already exists in this folder", "data": { "id": "0198…" } } }
```

### `PUT /api/notes/:id/content` — 409 `VERSION_CONFLICT`

```jsonc
// → { "content": "my new text", "baseVersion": 6 }
// ← 409
{
  "error": {
    "code": "VERSION_CONFLICT", "message": "someone saved this note first",
    "data": { "content": "what is on the server", "version": 7 }
  }
}
```

Same status as a name clash, different `code`: one is retried, the other needs a merge (§11.4).

The success side of the same endpoint, which is the half the editor lives on:

```jsonc
// → PUT /api/notes/0198…/content      If-Match: W/"v6"   (optional; must agree with baseVersion)
// → { "content": "my new text", "baseVersion": 6 }
// ← 200                                ETag: W/"v7"
{
  "id": "0198…", "name": "Draft", "folderId": null, "version": 7,
  "contentBytes": 11, "wordCount": 3, "content": "my new text",
  "contentUpdatedAt": "2026-11-19T09:04:11.000Z",
  "createdAt": "2026-11-19T09:00:00.000Z", "updatedAt": "2026-11-19T09:04:11.000Z"
}
```

`version` moved by exactly one, `content_updated_at` moved with the body, and the `ETag` is the validator for the
state the client just created — the next write may send it straight back as `If-Match`. A `PATCH` (rename or move)
would have left `version` where it was (**PR-10**).

### `PATCH /api/notes/:id` — 400 validation

```jsonc
// → { "name": "work/2026" }
// ← 400
{
  "error": {
    "code": "VALIDATION", "message": "the request body is not valid",
    "details": [{ "path": "name", "message": "must not contain \\ / : * ? \" < > | or control characters" }],
    "requestId": "req-42"
  }
}
```

`path` is dot-joined relative to the request body (an issue with no path reports as `body`); there are
no Zod codes on the wire.

### `GET /api/nope` — 404 from the route table

```jsonc
// ← 404
{
  "error": { "code": "NOT_FOUND", "message": "no route for GET /api/nope", "requestId": "req-7" }
}
```

A row that exists but belongs to someone else answers the same `NOT_FOUND` with
`note not found` — never `FORBIDDEN`, which would confirm the id exists.
