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

> **Status.** Only `GET /api/health` and `GET /api/healthz` are implemented today (by `apps/server`).
> Everything else below is the contract this PR pins, which the route PRs (**PR-07**, **PR-09**,
> **PR-10**, **PR-11**) implement; the "Lands in" column says which one, and the UI PRs (**PR-08**,
> **PR-12…PR-17**) only consume it. Until then an unknown path answers the envelope with
> `NOT_FOUND`, which is the shape every later route keeps.

## Conventions

| | |
| --- | --- |
| Base path | `/api` (`API_BASE_PATH`). In development Vite proxies `/api` to the API process, so the SPA calls the same paths with no configuration. |
| Content type | `application/json; charset=utf-8` both ways. Requests use `UTF-8` explicitly so the 1 MiB body cap is measured in bytes on the way in, not in characters. |
| Auth | The `HttpOnly` `note_session` cookie (plan §10). "Auth: yes" below means a valid session is required; `GET /api/auth/session` answers with `{ user: null }` instead of failing. |
| CSRF | Every mutation (`POST`/`PUT`/`PATCH`/`DELETE`) carries `X-CSRF-Token`, echoing the non-`HttpOnly` `note_csrf` cookie, which `GET /api/auth/status` issues. `login`/`setup`/`register` are exempt (`CSRF_EXEMPT_ROUTES`) and guarded by `Origin`/`Sec-Fetch-Site` instead (**PR-07**). |
| Payload cap | 1 MiB request body (Fastify `bodyLimit`) → `PAYLOAD_TOO_LARGE` (413). The UI warns at 900 KiB. |
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
| `RATE_LIMITED`      | 429  | Login rate limit or `auth_attempts` lockout                                                 |
| `PAYLOAD_TOO_LARGE` | 413  | Over the 1 MiB cap                                                                          |
| `INTERNAL`          | 500  | A bug. `message` is `internal error`; the real failure is in the log against `requestId`    |

Status is **not** the discriminator: `CONFLICT` and `VERSION_CONFLICT` share 409, and clients branch on
`code`. Postgres `40001` (serialization failure), `40P01` (deadlock) and `23505` (unique violation) map
to `CONFLICT`/409 rather than an unexplained 500 — all three are retryable, and a client that saw 500
would not retry.

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
| 1 | `GET /api/health`, `GET /api/healthz` | none | — | `{status:'ok', db:'ok', version}` | **PR-05** (the probe; `db` is a placeholder until PR-04 wires the pool) |
| 2 | `GET /api/auth/status` | none | — | `{needsSetup, registrationOpen}` | PR-07 |
| 3 | `POST /api/auth/setup` | none, only while `needsSetup` | `registerSchema` | `200 {user}` + cookie | PR-07 |
| 4 | `POST /api/auth/register` | none, only when registration is open **and** an owner exists | `registerSchema` | `201 {user}` + cookie | PR-07 |
| 5 | `POST /api/auth/login` | none | `loginSchema` | `200 {user}` + `note_session` | PR-07 |
| 6 | `POST /api/auth/logout` | yes | — | `204` | PR-07 |
| 7 | `POST /api/auth/logout-all` | yes | — | `204` | PR-07 (used by PR-16) |
| 8 | `GET /api/auth/session` | optional | — | `{user\|null, expiresAt?}` | PR-07 |
| 9 | `POST /api/auth/password` | yes | `changePasswordSchema` | `204` | PR-07 |
| 10 | `POST /api/users` | owner | `createUserSchema` | `201 {user}` | PR-07 |
| 11 | `GET /api/users` | owner | — | `usersResponseSchema` (`{users: SessionUser[]}`) | PR-07 |
| 12 | `GET /api/tree` | yes | — | `treeResponseSchema` (metadata, **no content**) | PR-09 |
| 13 | `POST /api/folders` | yes | `createFolderSchema` | `201 FolderNode` | PR-09 |
| 14 | `PATCH /api/folders/:id` | yes | `patchFolderSchema` | `200 FolderNode` | PR-09 |
| 15 | `DELETE /api/folders/:id` | yes | query `cascade=true` (`folderDeletePath()`) | `204` | PR-09 |
| 16 | `POST /api/notes` | yes | `createNoteSchema` | `201 NoteWithContent` | PR-09 |
| 17 | `GET /api/notes/:id` | yes | — | `NoteWithContent` + `ETag: W/"v<version>"` | PR-09 |
| 18 | `PUT /api/notes/:id/content` | yes | `contentUpdateSchema` | `200 NoteWithContent` (`version:version+1`) | PR-10 (the read side, #17, is PR-09) |
| 19 | `PATCH /api/notes/:id` | yes | `renameMoveSchema` | `200 NoteNode` | PR-09 |
| 20 | `DELETE /api/notes/:id` | yes | — | `204` | PR-09 |
| 21 | `GET /api/search?q=&limit=` (`searchPath()`) | yes | — | `searchResponseSchema` | PR-11 |
| 22 | `GET /api/settings`, `PATCH /api/settings` | yes | `patchSettingsSchema` | `Settings` | PR-09 |

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
