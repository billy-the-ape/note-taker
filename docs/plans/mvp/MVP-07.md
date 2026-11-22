# MVP-07 · PR-07 — Auth core (users, sessions, cookies, CSRF, rate limit, guards)

> **Task ID:** `PR-07` · **Branch:** `feat/pr-07-auth-api` · **Size:** M (1–2 days) · **Depends on:** PR-04, PR-05 (merged)
> **Track:** C Auth · **Review gate:** M1 · **Unblocks:** PR-08 (auth UI), PR-09 (authed routes), PR-16
> **ADR:** ADR-0004 (session cookies vs JWT) is written by **PR-20**; this PR implements the decision.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~27k tokens** | this brief (3.5k as written: endpoint subset, cookie/CSRF rules, schema rows) + PR-04's `schema.ts`/`test/{helpers,fixtures}` + PR-05's `auth.schemas.ts`/`domain/errors.ts`/`api.ts` semantics + `@node-rs/argon2` + `@fastify/cookie` docs + reading integration-run output for the race and CSRF assertions |
| **Output** | **~15k tokens** | 2 repositories, `auth.service.ts`, `auth.routes.ts`, `users.routes.ts`, `plugins/{auth-guard.ts,csrf.ts}`, `http/rate-limit.ts`, argon2 utils, `scripts/reset-password.ts`, ~6 `.int.test.ts` files |
| **Session total** | **~42k tokens** | ≈ one `M` engineer-day; budget ~55k if the concurrent-setup race or cookie-flag assertions take extra loops |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

Session-based authentication: username+password with argon2id, DB-backed opaque sessions in `HttpOnly` cookies, CSRF
double-submit, login rate limiting with durable audit rows, the auth guard used by every later route, the
owner-vs-member rules, and the only supported password-recovery script. **No UI** (PR-08).

## 2. Repo state you can assume (PR-04 + PR-05 merged)

Schema tables `users`, `sessions`, `settings`, `auth_attempts` exist with the indexes below; `test/fixtures.ts` inserts
users with raw schema inserts (one `owner`, one `member`); `test/helpers/app.ts` gives you `buildApp()` +
`app.inject()`; `domain/errors.ts` + `plugins/error-handler.ts` map errors to the envelope; `contracts` exports
`registerSchema`, `loginSchema`, `changePasswordSchema`, `sessionUserSchema`, `ROUTES`.
PR-05's client (`apps/web/src/lib/api.ts`) already implements the one-shot CSRF refresh-and-replay; **PR-07 adds no
`apps/web` files** — your job is the server half it replays against.

### Relevant schema (already generated in PR-04; do not change it)

```sql
users(id uuid PK, username text NOT NULL, password_hash text NOT NULL, display_name text,
      role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
      password_set_at timestamptz, created_at, updated_at)
CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
CREATE UNIQUE INDEX users_one_owner_uidx ON users (role) WHERE role = 'owner';   -- exactly one owner, DB-enforced

sessions(token_hash bytea PK,   -- sha256(session_token); the raw token only ever lives in the cookie
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         expires_at timestamptz NOT NULL, created_at, last_seen_at, user_agent text)

settings(user_id uuid PK REFERENCES users(id) ON DELETE CASCADE,
         autosave boolean NOT NULL DEFAULT true,
         theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
         updated_at timestamptz)   -- no trigger: the row is created by application code

auth_attempts(id uuid PK, user_key text NOT NULL /* lower(username) or ip */, succeeded boolean, at timestamptz)
```

Every other `user_id` FK in the schema is `ON DELETE CASCADE` (sessions, folders, notes, settings) — which is exactly why
deleting a user row is never a recovery path.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-07`; CI green; never lower a coverage threshold; docs updated in the
same PR (add an auth section to `docs/API.md` if PR-05's draft drifted; note `reset-password.js` for PR-18's
`docs/DEPLOY.md`); no secrets — test-only credentials.

## 4. Endpoints you implement (contracts already define the bodies)

| # | Method + path | Auth | Success | Rules |
| --- | --- | --- | --- | --- |
| 2 | `GET /api/auth/status` | none | `{needsSetup, registrationOpen}` | `needsSetup` ⇔ **no `role='owner'` row** (not "users is empty": a stray `member` must not flip it). **Issues/re-issues the `note_csrf` cookie.** |
| 3 | `POST /api/auth/setup` | none, only when `needsSetup` | `200 {user}` + session cookie | Creates the **owner**; `CONFLICT` once an owner exists. The guarantee is the DB, not the `needsSetup` read: `users_one_owner_uidx` makes a concurrent second setup impossible. |
| 4 | `POST /api/auth/register` | none, only when `ALLOW_REGISTRATION=true` **and** an owner exists | `201 {user}` + cookie | Creates `role='member'`; `FORBIDDEN` when the flag is false **or while no owner row exists**; rate-limited + `auth_attempts` like login; **can never create an owner** |
| 5 | `POST /api/auth/login` | none | `200 {user}` + `note_session` cookie | argon2id verify, timing-safe dummy hash for unknown users, rate-limited |
| 6 | `POST /api/auth/logout` | yes | `204` | Deletes the session row, clears the cookie, re-issues `note_csrf` |
| 7 | `POST /api/auth/logout-all` | yes | `204` | Deletes **every** session row for the user (consumed by PR-16's "sign out everywhere") |
| 8 | `GET /api/auth/session` | optional | `{user\|null, expiresAt?}` | Boot rehydration |
| 9 | `POST /api/auth/password` | yes | `204` | Rotates the session **and deletes all other sessions** — the acting session survives |
| 10 | `POST /api/users` | owner | `201 {user}` | Always `role='member'`; the only way to add accounts when `ALLOW_REGISTRATION=false` |
| 11 | `GET /api/users` | owner | `{users:[{id,username,role,createdAt}]}` | Minimal admin surface |

CSRF: every mutation needs `X-CSRF-Token` **except** `login`/`setup`/`register` — those have no session and, on a first
visit, no `note_csrf` cookie, so they are guarded by an `Origin`/`Sec-Fetch-Site` check instead. As built, the origin
that check compares against is the API's own `protocol` + `Host`, or — under `TRUST_PROXY=true` — the
`X-Forwarded-Host`/`X-Forwarded-Proto` pair, which is why `apps/web/vite.config.ts` keeps `changeOrigin: false`: a proxy
that rewrites `Host` makes every same-origin browser mutation look cross-origin (PR-07's review found exactly that;
`docs/API.md` §CSRF carries the operator rule).

## 5. Security rules (implement exactly)

**Transport & cookies**

- `note_session`: `HttpOnly`, `SameSite=Lax`, `Secure` when `SECURE_COOKIES=true`, `Path=/`,
  `Max-Age = SESSION_TTL_DAYS` (default 30). **Rotated on login and on password change.**
- Session token: 32 random bytes, base64url; the DB stores `sha256(token)` only ⇒ a DB dump cannot authenticate.
- `note_csrf`: non-`HttpOnly`, `SameSite=Lax`, `Path=/`, **`Max-Age = 1 day`** (shorter than the session), value =
  32 random bytes base64url. (Re-)issued by `GET /api/auth/status` **and** by every `setup`/`login`/`register`/`logout`
  response, so it is never older than the browser session carrying it. Deliberately **not** bound to a `sessions` row:
  double-submit equality + the `Origin`/`Sec-Fetch-Site` check is what does the binding in a single-instance MVP (a
  `sessions.csrf` column is backlog).
- Security headers via `@fastify/helmet`: CSP for the SPA (no `unsafe-eval`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Markdown preview sanitization is PR-13's concern, not yours.

**Passwords & brute force**

- argon2id via `@node-rs/argon2`, OWASP-ish parameters: `memoryCost 65536, timeCost 3, parallelism 1`; per-password
  random salt; the encoded string goes into `password_hash`.
- Password policy: ≥ 10 chars, not equal to the username, ≤ 512 bytes (argon2 pre-hash guard).
- Login rate limit: in-process sliding window — **10 attempts / 15 min per `lower(username)`+IP**
  (`LOGIN_RATE_LIMIT_MAX`) — **plus** durable `auth_attempts` rows for audit. The slot is taken as the request
  arrives, not when it fails, so the 11th attempt is refused even when it carries the right password (a limiter
  that counted only failures would let a burst of simultaneous guesses each read an empty window). On trip ⇒
  `429 RATE_LIMITED` with `Retry-After`.
- Unknown user ⇒ run a dummy `argon2.verify` so timing stays uniform; the 401 message is uniform for unknown user and
  wrong password.

**Tenancy / injection**

- No raw SQL string interpolation: Drizzle query builder + parameterized SQL only.
- `user_id` scoping is applied **inside repositories**, not routes, so a forgotten filter is structurally hard.

## 6. Files to create

`db/repositories/{users,sessions}.repo.ts` (final forms), `services/auth.service.ts`,
`routes/auth.routes.ts`, `routes/users.routes.ts`, `plugins/auth-guard.ts` (session resolution + `requireAuth`
preHandler), `plugins/csrf.ts` (cookie-to-header double submit + `Origin`/`Sec-Fetch-Site`),
`http/rate-limit.ts` (in-memory sliding window), argon2 hashing utils, `auth_attempts` writes,
and **`apps/server/src/scripts/reset-password.ts`**.

### The `settings` row is created here (not in PR-09)

**Every account-creating path (`setup`, `register`, `POST /api/users`) inserts the default `settings` row in the same
transaction as the `users` insert.** `settings.user_id` is the PK, there is no trigger, and PR-07 owns user creation, so
the row cannot be left to PR-09 (merges later) or the settings UI (PR-16): an owner created here would otherwise have no
row for `GET /api/settings`, and `PATCH /api/settings` would match zero rows — which is what PR-14's autosave flag and
PR-16 then break on. The insert is plain Drizzle on the `settings` table from `db/schema.ts`;
`settings.repo.ts` itself still lands in PR-09. A rolled-back user insert must leave no orphan settings row.

### `reset-password.ts` — the only supported password recovery

Same shipping rule as PR-06's rotation script: TypeScript under `apps/server/src/`, so `pnpm build` emits
`apps/server/dist/scripts/reset-password.js`; in production it runs as
`docker compose --env-file .env -f docker/compose.yml exec app node apps/server/dist/scripts/reset-password.js <username>`,
reading the new password from `argv` or a prompt, never from the URL. It **only** updates `users.password_hash` +
`password_set_at` and `DELETE`s that user's `sessions` rows. It must not touch anything else: every other `user_id` FK is
`ON DELETE CASCADE`, so deleting a user row would destroy their folders, notes and settings — and `POST /api/auth/setup`
refuses to run once an owner exists, so delete-and-re-set is data destruction followed by a blocked endpoint, not
recovery.

## 7. Acceptance criteria (integration tests)

- [ ] First run: `needsSetup=true` ⇒ `setup` creates the owner + session; `setup` after that ⇒ `CONFLICT`.
- [ ] Login success/failure; the failure is a uniform `401 UNAUTHORIZED` message.
- [ ] Cookie flags asserted on the responses (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`, `Secure` when
      `SECURE_COOKIES=true`).
- [ ] Logout invalidates: a subsequent `GET /api/auth/session` ⇒ `user:null`.
- [ ] Password change kills the **other** sessions (and rotates/keeps the acting one, per §4 #9).
- [ ] The **11th** login *attempt* within 15 min ⇒ `429` (with `Retry-After`), including an 11th that carries the
      right password; `auth_attempts` rows written for both success and failure.
- [ ] Missing CSRF header on a mutation ⇒ `403`.
- [ ] Session expiry honored (`expires_at`).
- [ ] **First-run race:** two concurrent `POST /api/auth/setup` against an empty DB ⇒ exactly one `200` + one `CONFLICT`,
      and `SELECT count(*) FROM users WHERE role='owner'` is **1** — the loser is caught by `users_one_owner_uidx`,
      proving the guard is the index and not the `needsSetup` read.
- [ ] **CSRF lifetime/re-issue:** a stale or missing `note_csrf` cookie is re-issued by `GET /api/auth/status` and by
      every `setup`/`login`/`register`/`logout` response (assert `Set-Cookie` on each) with `Max-Age=1 day`; a mutation
      that fails the check gets `403`. Prove the pair with PR-05's client rule: a mutation with a stale token gets `403`,
      the status refetch re-issues the cookie, and the **single** replay then succeeds.
- [ ] **Registration matrix:** with `ALLOW_REGISTRATION=false`, `POST /api/auth/register` ⇒ 403 and accounts can only be
      created by the owner via `POST /api/users`; with the flag `true`, `register` creates a `member` + session and
      `registrationOpen=true` appears in the status payload; and register still never creates the first owner — **on an
      empty DB with the flag true, `POST /api/auth/register` answers 403 and `GET /api/auth/status` still reports
      `needsSetup: true`; only after `POST /api/auth/setup` does register succeed.** Missing that guard leaves an install
      with zero owners, `/setup` permanently `CONFLICT`, and owner-only `POST /api/users` unreachable.
- [ ] **Default `settings` row per account:** after `setup`, after `register` (flag true, owner exists) and after
      `POST /api/users`, `SELECT * FROM settings WHERE user_id = <new user>` returns exactly **one** row with the schema
      defaults (`autosave=true`, `theme='system'`), and a rolled-back user insert leaves none.
- [ ] **`reset-password.ts`** executed as a **tsx subprocess** against the test DB (same rule as PR-06's rotation test —
      the `integration` job builds packages only, so nothing here may assume `dist/scripts/`): unknown username ⇒
      non-zero exit and **no writes**; success ⇒ the new password logs in, **all** that user's sessions are gone, and
      that user's `folders`/`notes`/`settings` rows are untouched (the regression guard against anyone "simplifying"
      recovery into deleting the user row).

## 8. Out of scope

Login UI (PR-08), passkeys (backlog PR-21), OAuth/2FA, email password reset (there is none — the script is the answer),
`settings` endpoints (PR-09).

## 9. PR body template

```
Task: PR-07

## What
argon2id + DB sessions (sha256 token hash) + cookie flags + rotation, CSRF double-submit with note_csrf re-issue on
status/setup/login/register/logout, Origin/Sec-Fetch-Site for the cookieless mutations, sliding-window rate limit +
auth_attempts, auth guard, setup/register/login matrix with the owner guard, settings row in the user transaction,
scripts/reset-password.ts.

## Acceptance evidence
- integration run: setup race (1 owner), rate limit 11th→429, CSRF re-issue + one-shot replay success,
  registration matrix, settings-row assertions, reset-password tsx subprocess run
- cookie flags captured from raw responses
```
