# MVP-08 · PR-08 — Auth UI (setup, login, sign-up, session context, route guards, UI kit v1)

> **Task ID:** `PR-08` · **Branch:** `feat/pr-08-auth-ui` · **Size:** M (1–2 days) · **Depends on:** PR-05, PR-07 (merged)
> **Track:** C Auth · **Review gate:** M1 ("a user can set up an account, log in, land on `/welcome`, log out — on a real
> DB, in Docker, in CI") · **Unblocks:** PR-12 (app shell), PR-16
> **Speed note:** you can start right after PR-05 against mocked handlers (`msw`-style, built from
> `packages/contracts`) while PR-07 lands.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~23k tokens** | this brief (2.1k as written) + PR-01's web scaffold (`main.tsx`, `routes/__root.tsx`, `index.tsx`, `globals.css`) + PR-05's `lib/api.ts` + `contracts` auth schemas/routes constants + PR-07's endpoint behavior + TanStack Router guard APIs + Radix primitives docs + jsdom test failures |
| **Output** | **~11k tokens** | 4 route files, `features/auth/{session.tsx,auth.api.ts,useSession.ts}`, 7 `components/ui/*` primitives, Tailwind theme tokens, error/not-found boundaries, ~5 component test files |
| **Session total** | **~34k tokens** | ≈ one `M` engineer-day; budget ~45k with the coverage-row arming and a11y label fixes |

> 1 token ≈ 4 chars; ±30%. If you use mocked handlers instead of a live API for the tests, add ~1k output tokens.

---

## 1. Goal

The first real screens: first-run `/setup`, `/login`, optional `/signup`, a signed-in placeholder `/welcome`, the session
context + route guards, and the UI kit everything else reuses. **No `/app` shell** — that is PR-12, which also deletes
`/welcome`.

## 2. Repo state you can assume (PR-05 + PR-07 merged)

- `apps/web` (Vite 7 + React 19 + TanStack Router file-based routes + TanStack Query + Tailwind v4), with
  `routes/__root.tsx`, a placeholder `routes/index.tsx`, and `lib/{api.ts,queryClient.ts}` from PR-05.
  `apps/web/vitest.config.ts` has an `apps/web/src/lib` threshold row and **no** overall `apps/web/src` row.
- `@note-taker/contracts` exports `registerSchema`, `loginSchema`, `changePasswordSchema`, `sessionUserSchema`,
  `ROUTES` path constants, and the error envelope types.
- The server (PR-07) serves: `GET /api/auth/status` (`{needsSetup, registrationOpen}`, issues `note_csrf`),
  `POST /api/auth/setup`, `POST /api/auth/register` (403 unless `ALLOW_REGISTRATION=true` **and** an owner exists),
  `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/logout-all`, `GET /api/auth/session`,
  `POST /api/auth/password`, plus owner-only `POST /api/users` / `GET /api/users`.
  All bodies use the contracts schemas; every non-2xx is
  `{error:{code,message,details?,requestId}}` with `code ∈ VALIDATION|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|
  RATE_LIMITED|VERSION_CONFLICT|PAYLOAD_TOO_LARGE|INTERNAL`.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-08`; CI green; **never lower a coverage threshold** — this PR *raises*
one (below); docs updated in the same PR (`AGENTS.md`/`README.md` if commands or routes change).

## 4. Routes and guards (exact)

| Path | Guard | Purpose |
| --- | --- | --- |
| `/setup` | only when `needsSetup` | create the first account |
| `/login` | redirect away when authed | username + password, error + rate-limit messaging |
| `/signup` | only when `registrationOpen` **AND** `!needsSetup`; otherwise redirect to `/login` (`/setup` on a fresh install) | self-sign-up form; creates a `member` |
| `/welcome` | auth | **placeholder home this PR owns**: a minimal signed-in card with the username + a sign-out button |
| `*` | — | redirect: authed → `/welcome` (until PR-12 creates `/app`), else → `/login` or `/setup` |

**Route guards live in the layout route's `beforeLoad` reading the session context — never per page.** TanStack Router's
convention for a directory layout is `route.tsx` inside the directory (`routes/app/route.tsx`), not Next.js's
`__layout.tsx`. That file is created by PR-12; until then the authed redirect target is `/welcome`, which is what keeps
this PR's acceptance testable on its own.

## 5. Files to create

- `apps/web/src/routes/{setup.tsx,login.tsx,signup.tsx,welcome.tsx}`.
- `apps/web/src/features/auth/{session.tsx,auth.api.ts,useSession.ts}` — session context provider (boot rehydration via
  `GET /api/auth/session` + `GET /api/auth/status`), the API calls, and the hook.
- `apps/web/src/components/ui/` — **Button, Input, Field, Dialog, Menu, Toast, Spinner**: Radix primitives + Tailwind,
  a thin set with no design system. Later PRs grow this folder; make it pleasant to extend.
- Tailwind theme tokens in `styles/globals.css` (light/dark, `prefers-color-scheme` default) and global
  error / not-found boundaries.
- Component tests (Vitest + `@testing-library/react`) for form validation + error rendering.

## 6. Required behavior

- Password inputs have real `<label>`s and `autocomplete` attributes (`username`, `current-password`, `new-password`).
- The server's `error.message` is shown inline (wrong password, `RATE_LIMITED` with its `Retry-After`); never a blank
  failure. Toasts on failed mutations.
- Success lands on `/welcome`; `/login` while already authed redirects to `/welcome`; refresh keeps the session
  (`GET /api/auth/session`); the sign-out control returns to `/login`.
- `/signup` link on `/login` only when the status payload reports `registrationOpen: true` **and** `needsSetup` is false;
  a direct `/signup` visit redirects to `/login`, and to `/setup` on a fresh install — the **UI mirror of PR-07's 403**,
  so nobody can walk into the no-owner dead end through the browser.
- No global client store (no Redux/Zustand): Query + Router cover state. Transient UI state is local + a tiny `ui` store
  persisted in `localStorage` (needed later by PR-12/13; keep it minimal now).

## 7. Coverage gate you arm

Add the overall **`apps/web/src`** row to `apps/web/vitest.config.ts`: **55 lines / 55 functions / 50 branches /
55 statements** (it ratchets to 65 after PR-19). The `apps/web/src/lib` row (80/80/75/80) already exists from PR-05, and
`passWithNoTests: true` was dropped there — from PR-05 on, an empty web suite is a failure. Keep thresholds in the
config, never in CI flags.

## 8. Acceptance criteria (playwright-able in spirit; assert in Vitest + testing-library now, PR-19 replays them in e2e)

- [ ] Unauth visit → `/login`; `needsSetup` → `/setup`.
- [ ] Wrong password shows the server message; success lands on `/welcome`.
- [ ] Refresh keeps the session; the sign-out control on `/welcome` returns to `/login`.
- [ ] `/login` when authed redirects to `/welcome`.
- [ ] Password inputs have labels + autocomplete attributes.
- [ ] Component tests cover form validation and error rendering (register: short password, username-equality,
      confirm-password mismatch; login: 401 and 429 paths).
- [ ] With `ALLOW_REGISTRATION=true` **and an owner already existing**: `/login` links `/signup` and the form creates a
      member and lands on `/welcome`. With the flag false: `/signup` is unreachable from the UI and a direct visit
      redirects to `/login`. On a **fresh install** (flag true, `needsSetup: true`): the link is hidden and a direct
      `/signup` visit redirects to `/setup`.
- [ ] `apps/web/src` overall coverage ≥ 55/55/50/55; `pnpm coverage` green in the `unit` job.

## 9. Out of scope

The `/app` shell, `routes/app/route.tsx`, and every `/app` assertion (PR-12 — which also **deletes
`routes/welcome.tsx`**), the settings page (PR-16), user-management UI (backlog), password-reset UI (the supported
recovery is PR-07's operator script; an owner-facing UI reset is an open question in the plan, not this PR).

## 10. PR body template

```
Task: PR-08

## What
routes setup/login/signup/welcome, features/auth session context + guard plumbing, components/ui v1 (Radix + Tailwind),
Tailwind light/dark tokens, error + not-found boundaries, web coverage row armed (55/55/50/55).

## Acceptance evidence
- vitest run: guard redirects, signup visibility matrix (flag × owner-exists × needsSetup), error rendering
- short screen recording or screenshots: setup → welcome → sign out → login
```
