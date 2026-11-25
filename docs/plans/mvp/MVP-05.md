# MVP-05 · PR-05 — Shared contracts (Zod DTOs, error envelope, typed client)

> **Task ID:** `PR-05` · **Branch:** `feat/pr-05-contracts` · **Size:** M (1–2 days) · **Depends on:** PR-01 (merged)
> **Track:** B Data & contracts · **Unblocks:** PR-06, PR-07, PR-08, PR-09…PR-17 — **land it as early as possible**; it
> is the contract every parallel track builds against.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~28k tokens** | this brief (4.4k as written: name-rule sketch, error envelope incl. the `data` payload field, full endpoint table) + PR-01's `apps/server/src/{app.ts,env.ts}` and Vitest configs + Zod v4 + fastify-type-provider-zod docs + reading your own `tsc` errors across the two apps |
| **Output** | **~14k tokens** | `packages/contracts` (10 source files + 4 test files + `package.json`/`tsconfig`/`vitest.config`), `docs/API.md`, `apps/web/src/lib/{api.ts,queryClient.ts}` + their mocked-`fetch` tests, `apps/server/src/{domain/errors.ts,plugins/error-handler.ts}` |
| **Session total** | **~42k tokens** | ≈ one `M` engineer-day; budget ~55k if the dist-resolution acceptance needs more than one loop |

> 1 token ≈ 4 chars; ±30%. The dist-resolution acceptance (negative control) is what usually costs extra iterations.

---

## 1. Goal

One package that defines **every payload** shared by client and server, with a real build/export story (compiled `dist`
+ declarations), plus the typed client wrapper and the server's error plumbing — all **before any route exists**. Later
PRs only *add mapping cases* to the two server files; they never re-create them.

## 2. Repo state you can assume (PR-01 merged)

pnpm monorepo with `apps/server` (Fastify 5, `buildApp(deps)`, health route) and `apps/web` (Vite/React/TanStack).
`build:packages` (`pnpm -r --filter './packages/**' build`) already exists at the root and is currently a no-op; the
web Vitest config currently sets `passWithNoTests: true` and declares **no** coverage thresholds. No `packages/` yet.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-05`; CI green; never lower a coverage threshold; docs updated in the
same PR (`docs/API.md` is created here; `AGENTS.md` gains the `build:packages` note if it lists commands); no secrets.

## 4. The build/export story (not optional — PR-18's runtime depends on it)

- `packages/contracts/package.json`: `"name": "@note-taker/contracts"`, `"type": "module"`, `"main"`/`"types"` and
  `"exports"` **all pointing at `./dist/index.js` / `./dist/index.d.ts`**, `"scripts": { "build": "tsc -p tsconfig.json", "test": … }`.
- `packages/contracts/tsconfig.json` extends the base with `outDir: "dist"`, `declaration: true`.
- Root `pnpm build` builds workspaces in dependency order:
  `pnpm -r --filter './packages/**' build && pnpm -r --filter './apps/**' build` (or `pnpm -r build` once every
  workspace has a `build` script).
- **Nothing aliases the package to its sources** — no `paths` mapping, no Vitest alias, no `development` export
  condition — so dist-backed resolution is identical in dev, CI, and the production image (`pnpm dev` already runs
  `build:packages` first; iterating on contracts means a fourth terminal running
  `pnpm --filter @note-taker/contracts build -- --watch`).
- Only runtime dependency: **zod v4**.
- Consequence for CI (already wired in PR-03): `pnpm build:packages` runs in every job that typechecks or tests app
  code. Your PR makes that step **load-bearing** and proves the failure mode is gone.

## 5. Files to create

**`packages/contracts/`**: `package.json`, `tsconfig.json`, `vitest.config.ts`, and `src/`:

| File | Contents |
| --- | --- |
| `index.ts` | barrel export |
| `api-envelope.ts` | `ApiErrorCode`, `errorResponseSchema`, paginated/list helpers |
| `auth.schemas.ts` | `registerSchema`, `loginSchema`, `sessionUserSchema`, `changePasswordSchema` |
| `tree.schemas.ts` | `folderNodeSchema`, `noteNodeSchema`, `treeResponseSchema` |
| `notes.schemas.ts` | `createNoteSchema`, `renameMoveSchema`, `contentUpdateSchema`, `noteSchema` |
| `folders.schemas.ts` | `createFolderSchema`, `patchFolderSchema`, `deleteOptionsSchema` |
| `settings.schemas.ts` | `settingsSchema`, `patchSettingsSchema` |
| `search.schemas.ts` | `searchQuerySchema`, `searchResultSchema` |
| `names.ts` | the note-name rules (below) — the README's `new-file-<msepoch>.md` rule lives here and **nowhere else** |
| `routes.ts` | `ROUTES` path constants shared by client & server |
| `*.test.ts` | unit tests (name rules, uniquify sequences, validation edges) |

**`docs/API.md`** — documents the whole endpoint table below with request/response examples; it is the reference the
server and client both match.

**`apps/web/src/lib/api.ts`** — typed fetch wrapper: `json()`, `ApiError`, CSRF header injection, 401 handling hook,
**and the one-shot CSRF recovery**: on a `403` from a mutation it re-fetches `/api/auth/status` **once** and replays the
mutation **once**, never twice.

**`apps/web/src/lib/queryClient.ts`** — TanStack Query client with the cache-key conventions
(`['tree',userId]`, `['note',id]`, `['settings']`).

**`apps/server/src/domain/errors.ts`** — typed domain errors: `NotFoundError`, `ConflictError`,
`VersionConflictError`, … (the version-conflict variant carries the current server `content` + `version`).

**`apps/server/src/plugins/error-handler.ts`** — Zod / Drizzle / domain error → the envelope below, **registered inside
`buildApp()`**. Include Postgres `40001` (serialization failure) and `40P01` (deadlock) → `CONFLICT` (409): they are
client-retryable and must never surface as an unexplained `INTERNAL`.

**`packages/contracts/vitest.config.ts`** — unit scope: `include: ['src/**/*.test.ts']`,
`exclude: ['**/*.int.test.ts']`; contracts needs no DB.

## 6. Error envelope (every non-2xx)

```jsonc
{ "error": { "code": "CONFLICT", "message": "name already exists in this folder",
             "details": [{ "path": "name", "message": "must be unique among siblings" }],
             "data": { "id": "0f6f0c1a-…" }, "requestId": "…" } }
```

`code ∈ VALIDATION | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | VERSION_CONFLICT |
PAYLOAD_TOO_LARGE | INTERNAL`.

- A sibling-name clash is always `CONFLICT` (409), never `VALIDATION`. `VALIDATION` (400) is reserved for malformed
  payloads (bad characters, length, missing fields).
- **`data` is the optional, code-specific payload object** — the only place structured extras travel, so `details`
  stays a list of field errors. `CONFLICT` from a duplicate create carries `data: { id }` (the existing row, so a
  double-clicked "Create" can adopt it instead of firing twice); `VERSION_CONFLICT` carries
  `data: { content, version }` (the current server plaintext + version — the exact pair PR-14's autosave engine
  compares against the snapshot it put on the wire). Every other code omits `data`.
  Pin these field names in `api-envelope.ts` (a `data` key on the error schema) and in `docs/API.md`: PR-09, PR-10 and
  PR-14 all read them.
- `requestId` is echoed in logs for support.
- Cross-user access is always `404` (never `403`) so ids cannot be probed.

## 7. Endpoint table (define schemas for all of it; you do not register routes)

Base path `/api`, `application/json; charset=utf-8`. All bodies validated with these schemas via
`fastify-type-provider-zod`. Payload cap: 1 MiB note body (→ `PAYLOAD_TOO_LARGE`); UI warns at 900 KiB.

| # | Method + path | Auth | Request | Success | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /api/health` | none | — | `{status:'ok', db:'ok', version}` | also `GET /api/healthz` for the Docker `HEALTHCHECK` |
| 2 | `GET /api/auth/status` | none | — | `{needsSetup, registrationOpen}` | `needsSetup` ⇔ no `role='owner'` row; **also issues the `note_csrf` cookie** (PR-07) |
| 3 | `POST /api/auth/setup` | none, only when `needsSetup` | `registerSchema {username,password,displayName?}` | `200 {user}` + cookie | creates the `owner`; `CONFLICT` once an owner exists |
| 4 | `POST /api/auth/register` | none, only when `ALLOW_REGISTRATION=true` **and** an owner exists | `registerSchema` (no `displayName`) | `201 {user}` + cookie | creates `role='member'`; 403 otherwise |
| 5 | `POST /api/auth/login` | none | `{username,password}` | `200 {user}` + `note_session` cookie | argon2id verify, rate-limited |
| 6 | `POST /api/auth/logout` | yes | — | `204` | deletes session, clears cookie |
| 7 | `POST /api/auth/logout-all` | yes | — | `204` | every session for the user (PR-07 ships, PR-16 consumes) |
| 8 | `GET /api/auth/session` | optional | — | `{user\|null, expiresAt?}` | rehydrates UI on boot |
| 9 | `POST /api/auth/password` | yes | `{currentPassword,newPassword}` | `204` | rotates + deletes **all other** sessions |
| 10 | `POST /api/users` | owner | `{username,password}` | `201 {user}` | always `role='member'`; the only way to add accounts when registration is closed |
| 11 | `GET /api/users` | owner | — | `{users:[{id,username,role,createdAt}]}` | minimal admin surface |
| 12 | `GET /api/tree` | yes | — | `{folders:[FolderNode], notes:[NoteNode]}` | metadata only, **no content** |
| 13 | `POST /api/folders` | yes | `{name, parentId\|null}` | `201 FolderNode` | 409 sibling clash; 400 `VALIDATION` at depth 100 |
| 14 | `PATCH /api/folders/:id` | yes | `{name?, parentId?}` | `200 FolderNode` | rename/move; cycle guard; move cap check `depth(newParent)+1+height(subtree) ≤ 99` |
| 15 | `DELETE /api/folders/:id` | yes | query `cascade=true` | `204` | without `cascade=true` and non-empty ⇒ `CONFLICT` |
| 16 | `POST /api/notes` | yes | `{name?, folderId\|null, content?}` | `201 NoteWithContent` | no `name` ⇒ server generates `new-file-<msepoch>` and uniquifies; `folderId: null` = root; no `content` ⇒ sealed empty string |
| 17 | `GET /api/notes/:id` | yes | — | `{…NoteNode, content, version}` | decrypts; `ETag: W/"v<version>"` |
| 18 | `PUT /api/notes/:id/content` | yes | `{content, baseVersion}` | `{…NoteNode, content, version:version+1}` | `baseVersion` mismatch ⇒ `VERSION_CONFLICT` **+ current server content + version** |
| 19 | `PATCH /api/notes/:id` | yes | `{name?, folderId\|null}` | `200 NoteNode` | rename/move; `notes.name` stays extension-free |
| 20 | `DELETE /api/notes/:id` | yes | — | `204` | |
| 21 | `GET /api/search?q=&limit=` | yes | — | `{results:[{noteId,name,folderPath,snippet,score}]}` | ≤ 25 results |
| 22 | `GET /api/settings` · `PATCH /api/settings` | yes | `patchSettingsSchema` | `Settings` | `autosave`, `theme` (server lands in PR-09) |

Concurrency/idempotency rules worth encoding in schemas/types: content writes are versioned (never last-write-wins);
`POST /api/notes` / `POST /api/folders` return `CONFLICT` **including the existing id** on a duplicate create, so a
double-click ends with one row; all mutations need the `X-CSRF-Token` header **except** `login`/`setup`/`register`
(guarded by `Origin`/`Sec-Fetch-Site` instead).

## 8. `names.ts` — the exact rules (pin them with tests)

```ts
export const NOTE_NAME_MAX = 120;
export const MD_EXT = '.md';
export const newFileName = (msEpoch: number = Date.now()) => `new-file-${msEpoch}${MD_EXT}`;
// "Draft.md" -> "Draft" (names are stored extension-free). Exactly ONE suffix is removed — which is only safe
// because isValidNoteName() below rejects a stripped name that still ends in .md.
export const stripMd = (name: string) => name.toLowerCase().endsWith(MD_EXT) ? name.slice(0, -MD_EXT.length) : name;
export const withMd = (name: string) => stripMd(name) + MD_EXT; // display only
const endsInMd = (s: string) => s.toLowerCase().endsWith(MD_EXT);
export const isValidNoteName = (raw: string): boolean => {
  const base = stripMd(raw);   // every rule runs on the STRIPPED name ("..md" → "." must fail, "foo .md" → "foo " must fail)
  return base.length > 0 && base.length <= NOTE_NAME_MAX &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(base) && base === base.trim() && base !== '.' && base !== '..' &&
    // …and the stripped result may not STILL end in .md. "foo.md.md" would otherwise be stored as "foo.md":
    // that breaks the "no .md in the DB" invariant, makes the stored rows `foo` and `foo.md` render identically
    // (withMd turns both into "foo.md"), and loses characters when a rename prefill strips again.
    // Rejecting is deliberate: silently stripping twice would make "foo.md.md" collide with "foo".
    // This is also what makes stripMd idempotent over valid input — the property PR-05 tests:
    //   isValidNoteName(n) ⇒ stripMd(stripMd(n)) === stripMd(n)
    !endsInMd(base);
};
// Works on the extension-free base, because that is what is stored: "plan" → "plan-2" → "plan-3".
// withMd() renders the ".md"; uniquify must never emit a name that still carries the extension.
export const uniquify = (name: string, taken: Set<string>): string => { /* base, base-2, base-3 … */ };
```

Plus `createNoteSchema.superRefine` enforcing them, and folder name rules (same character/length rules, **no extension
handling**). Reserved characters include `/ \ : * ? " < > |` and NUL/control chars; no leading/trailing space; length
clamped to 120.

## 9. Client rules you own here (PR-07 provides the server half)

`note_csrf` is a non-`HttpOnly` cookie, `SameSite=Lax`, `Path=/`, `Max-Age = 1 day`, value = 32 random bytes base64url,
(re-)issued by `GET /api/auth/status` and by every `setup`/`login`/`register`/`logout` response. `lib/api.ts` echoes the
cookie value in the `X-CSRF-Token` header on every mutation. On a `403` from a mutation it re-fetches
`/api/auth/status` **once** and replays the mutation **once** before surfacing the error, so a long-open tab recovers
instead of failing forever. `ApiError` carries `code`, `message`, `details`, `data`, `requestId` — `data` so PR-14's
engine can read the conflict payload without re-fetching the note.

## 10. Coverage + CI

- Add the **`packages/contracts`** row thresholds to `packages/contracts/vitest.config.ts`: 90 lines / 90 functions /
  85 branches / 90 statements (ratcheting to 95 across the board after PR-19). Pure module, no excuse; it is a `unit`-job
  scope because contracts needs no DB.
- Add the **`apps/web/src/lib`** row thresholds (80/80/75/80) to `apps/web/vitest.config.ts` and **drop PR-01's
  `passWithNoTests: true`** — your mocked-`fetch` tests are the first web tests, so from here on an empty web suite is a
  failure. The overall `apps/web/src` row still waits: plan §14 assigns it to PR-16, which lands the first components a
  Postgres-free web suite can render.
- Acceptance includes the **negative control**: with `packages/contracts/dist` deleted, `pnpm -w typecheck` fails to
  resolve `@note-taker/contracts` — proof that `exports` → `dist` is what CI relies on.

## 11. Acceptance criteria

- [ ] `pnpm build` produces `packages/contracts/dist/index.js` + `index.d.ts`, and from `apps/server`:
      `node --input-type=module -e "import('@note-taker/contracts').then(m => console.log(typeof m.createNoteSchema))"`
      prints `object` — the compiled server resolves the package at runtime with nothing from `src/` involved.
- [ ] `pnpm -w typecheck` resolves contracts from both apps **only after** `pnpm build:packages` (negative control above).
- [ ] Positive half: **`pnpm i && pnpm dev` from a bare clone still boots** now that the server really imports the
      package — it only holds because `dev` runs `build:packages` first.
- [ ] Contract unit tests cover: name rules (unicode, 121 chars, path chars, existing sibling) **and the stripped-name
      edge cases**: `"..md"` and `"foo .md"` rejected because every rule runs on `stripMd(name)`; `"foo.md.md"` and
      `"foo.md.MD"` rejected because the stripped result *still* ends in `.md` (the case that would otherwise store
      `foo.md` and render it identically to the stored note `foo`).
- [ ] Strip-idempotence property: `isValidNoteName(n) ⇒ stripMd(stripMd(n)) === stripMd(n)`
      (equivalently `!endsInMd(stripMd(n))`; over already-stored names, `stripMd(stored) === stored`). Deliberately
      **not** `isValidNoteName(n) ⇒ stripMd(n) === n` — that is false for `Draft.md`, which the rules accept.
- [ ] Collision property: two distinct stored names never render to the same `withMd()` display string.
- [ ] `uniquify` sequences: `plan` → `plan-2` → `plan-3`, **never** `plan.md-2`.
- [ ] Error envelope typing exercised; `apps/server` error handler maps Zod + domain errors + `40001`/`40P01` →
      `CONFLICT` (unit-tested through `buildApp()` + `app.inject()` with a stub route or the error handler directly).
- [ ] First web unit tests pass with mocked `fetch`: CSRF header echoed from the cookie, `ApiError` shape, one-shot 403
      recovery (exactly **one** status refetch, exactly **one** replay, a second 403 surfaces the error), and the 401
      hook.
- [ ] `docs/API.md` documents every endpoint above with examples.

## 12. Out of scope

Registering any route (each route PR does that), auth/session logic, encryption, UI components.

## 13. PR body template

```
Task: PR-05

## What
packages/contracts (zod v4 schemas, names.ts, routes.ts, envelope) built to dist + declarations; docs/API.md;
apps/web/src/lib/{api.ts,queryClient.ts} with one-shot CSRF refresh-and-replay; apps/server domain/errors.ts +
plugins/error-handler.ts (incl. 40001/40P01 → CONFLICT).

## Acceptance evidence
- dist resolution proof (`node --input-type=module …` → object)
- negative control: rm -rf packages/contracts/dist → pnpm -w typecheck fails
- bare clone `pnpm i && pnpm dev` still boots
- coverage: contracts 90/90/85/90, apps/web/src/lib 80/80/75/80
```
