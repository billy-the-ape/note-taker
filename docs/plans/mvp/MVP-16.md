# MVP-16 · PR-16 — Settings UI (autosave toggle, theme, change-password form)

> **Task ID:** `PR-16` · **Branch:** `feat/pr-16-settings` · **Size:** M (1–2 days)
> **Depends on:** PR-07 (change-password + logout-all), PR-09 (**settings API**), PR-14 (the engine that consumes the flag)
> **Track:** E UI · **Review gate:** M3 · **No new server code** — the settings API already shipped in PR-09.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~19k tokens** | this brief (1.5k as written) + PR-14's `useAutosave()` injection surface + PR-09's settings endpoints + PR-07's session/password/logout-all behavior + PR-08's `components/ui/*` + session context + TanStack Query mutation/invalidation patterns |
| **Output** | **~7k tokens** | `routes/app/settings.tsx`, `features/settings/*`, theme application, settings→`useAutosave()` wiring, ~3 test files |
| **Session total** | **~26k tokens** | ≈ one `M` engineer-day (the session-rotation assertions dominate) |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

`/app/settings`: the autosave toggle (effective immediately in an already-open editor), theme (light/dark/system), the
change-password form, and "sign out everywhere". The only server-side work here is a **regression test** proving the flag
round-trips into the open editor.

## 2. Repo state you can assume

- Server (PR-09): `GET /api/settings` → `{autosave, theme}` (get-or-create — never 404, never an empty body) and
  `PATCH /api/settings` (`patchSettingsSchema`) → the updated `Settings`.
- Server (PR-07): `POST /api/auth/password {currentPassword,newPassword}` → `204`, which **rotates the acting session and
  deletes all the user's other sessions**; `POST /api/auth/logout-all` → `204`, deleting **every** session row including
  the current one; `GET /api/auth/session` for rehydration. Password policy: ≥ 10 chars, not equal to the username,
  ≤ 512 bytes.
- PR-14: `useAutosave()` takes `autosave: boolean` as an **injected** input; the pill renders
  `Autosave off — Ctrl+S to save` when it is false.
- PR-08: `components/ui/{Button,Input,Field,Dialog,Menu,Toast,Spinner}.tsx`, session context (`features/auth/*`),
  Tailwind light/dark tokens with `prefers-color-scheme` default.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-16`; CI green; never lower a coverage threshold; docs updated in the
same PR.

## 4. Files to create

`apps/web/src/routes/app/settings.tsx`, `apps/web/src/features/settings/*` (queries/mutations/hooks), theme application
(`class="dark"` on `<html>`, applied from the settings value with `system` resolving through
`matchMedia('(prefers-color-scheme: dark)')`), and the wiring that feeds `GET/PATCH /api/settings` into `useAutosave()`.

`data-testid`s for PR-19: `settings-autosave-toggle`, `settings-theme-select`, `settings-theme-light`,
`settings-theme-dark`, `settings-theme-system`, `change-password-form`, `sign-out-everywhere`.

## 5. Behavior

- Autosave toggle → optimistic `PATCH`, invalidates `['settings']`, and the **already-open editor reacts immediately**
  (pill text changes, no debounce writes while off, `Ctrl/Cmd+S` and the explicit Save button still work, navigating away
  with a dirty buffer prompts "Save / Discard / Stay").
- Theme select (system/light/dark) → persisted via `PATCH /api/settings`, applied as `class="dark"` on `<html>`, survives
  reload, and `system` follows the OS.
- Change-password form: validates the current password (server error rendered inline), and after success
  **the current session survives** — no forced re-login — while every other session of that user is deleted, so another
  tab fails on its next request.
- "Sign out everywhere" → `POST /api/auth/logout-all`, lands on `/login`, and invalidates every other tab on its next
  request.
- Cache keys stay `['settings']`; no new global store.

## 6. Acceptance criteria

- [ ] Toggling autosave off takes effect immediately in the open editor (pill + zero debounce writes); toggling it back
      on resumes debouncing. **This is the regression test that the flag round-trips into the editor.**
- [ ] Change-password form validates the current password (wrong current password ⇒ inline error, nothing changes).
- [ ] **The current session is rotated and survives** — no forced re-login — while every **other** session of that user
      is deleted (assert: the acting session still returns a user from `GET /api/auth/session`; a second session token
      now answers `401`).
- [ ] "Sign out everywhere" calls `POST /api/auth/logout-all`, lands on `/login`, and invalidates every other tab's next
      request.
- [ ] Theme persists across reload and respects `system` (assert both the stored value and the applied `class`).
- [ ] A settings user with **no** row still gets defaults (PR-09's get-or-create) — the settings page never renders an
      error state for a fresh account.
- [ ] Coverage: `apps/web/src` ≥ 55/55/50/55 (nothing lowered).

## 7. Out of scope

User management UI beyond PR-07's API (backlog PR-28), an owner-facing password reset for *other* users (an open product
question; the supported recovery today is PR-07's operator script `reset-password.js`, documented by PR-18), email
password reset (none in the MVP), passkeys (backlog PR-21), brand theming beyond light/dark/system.

## 8. PR body template

```
Task: PR-16

## What
routes/app/settings, features/settings (GET/PATCH settings wired into useAutosave), theme application (class="dark" +
system), change-password form (session rotation semantics), sign-out-everywhere (logout-all).

## Acceptance evidence
- vitest run: autosave toggle effective in the open editor (pill + no debounce writes), change-password keeps the current
  session and kills others, logout-all redirect, theme persistence + system resolution
```

## 9. What landed (record, written by the PR that did the work)

Only **PR-07** of the three dependencies named in the header is in this tree: **PR-09's settings endpoints are not
registered** (`app.ts` mounts health, auth and users only — the `settings` *table* is PR-04's, with the defaults PR-09
documents), **PR-14 has not merged**, and PR-08 — whose `components/ui/*` and session context §2 assumes — is not
merged either. One acceptance mechanism therefore had to be chosen rather than assumed. All of it is recorded here
because the next PR reads this file, not the commit messages.

| §6 criterion | Where it is asserted |
| --- | --- |
| Autosave off takes effect immediately in the **open** editor; back on resumes debouncing | `features/settings/autosave-roundtrip.test.tsx` (the flag reaches the editor through one `QueryClient`, with the `PATCH` still in flight; zero debounce writes while off; `Ctrl/Cmd+S` and the Save button still write) |
| Wrong current password ⇒ inline error, nothing changes | `features/settings/change-password.test.tsx` (the server's `401` text is rendered under the form; password, sessions, route and cache all unchanged) |
| The acting session survives; every other session answers `401` | same file, third test (`GET /api/auth/session` still returns a user on the **rotated** cookie; the second tab's next guarded request is a `401`) |
| Sign out everywhere ⇒ `logout-all`, `/login`, other tabs dead | `features/settings/sign-out-everywhere.test.tsx` |
| Theme persists across reload and respects `system` (stored value **and** applied class) | `features/settings/theme.test.ts` + `features/settings/theme-sync.test.tsx` |
| A user with no settings row still gets defaults | `theme-sync.test.tsx` (last test) and `settings-page.test.tsx`, both against a fake whose first read creates the server's defaults |
| `apps/web/src` ≥ 55/55/50/55 | armed in `apps/web/vitest.config.ts` (at 89.6% lines when this landed) |

- **PR-09's endpoints are not registered**, so the two settings calls are exercised against `src/test/fake-api.ts`,
  whose semantics are taken from `docs/API.md` #22 and `db/schema.ts` (`autosave` default `true`, `theme` default
  `'system'`, `settings_theme_check`) rather than invented here. The credential calls are the opposite case: they *are*
  served, and PR-07's own `apps/server/src/routes/auth.routes.int.test.ts` ("kills the old password, keeps this session
  alive, and deletes every other one") proves the same semantics server-side — which is what makes pinning the rotation
  criterion from the client half safe. PR-09 has since landed, and `apps/server/src/routes/settings.routes.int.test.ts`
  is the server-side half the fake is meant to track — keep the two in step, exactly as `fake-api.ts` says.
- **PR-08 was absent when this was written**, so the screen is self-contained Tailwind rather than `components/ui/*`,
  and `ApiClientProvider` is `lib/api-client-context.tsx` — PR-16's own. PR-08 has since merged and did **not** add a
  provider (its components call the `lib/api` singleton directly), so this file stays; whether a later PR re-exports it
  is open. The **overall `apps/web/src` coverage row** was armed here for the same reason, and PR-08 armed the same row
  independently: merging the two kept **PR-08's `'src/**'` row** and dropped PR-16's duplicate `'**'` key (plan §14
  says so, and `apps/web/vitest.config.ts` says why).
- **PR-14 was absent.** The flag's consumer was `apps/web/src/test/editor-harness.tsx`, a ~50-line stand-in that
  implements exactly PR-14 §6's `settings.autosave === false` rule and is documented as a harness rather than a
  component. `useAutosaveEnabled()` is the injection surface PR-14 briefs, and PR-14 has since merged:
  `features/notes/useAutosave.ts` reads `settingsOptions()` / `autosaveFlag()` from the merged `features/settings/settings.api.ts`.
  The harness survived the merge on purpose — PR-16's assertions are about the *flag contract*, not the engine — but the
  follow-up is for PR-14's engine to cover those same rows rather than leave two implementations of one rule.
- **"Navigating away with a dirty buffer prompts Save / Discard / Stay" (§5) is not implemented here.** That prompt is
  a router blocker, and `routes/app/route.tsx` — PR-12's, which has since merged — is where the `useBlocker` kit hangs
  off, while the note route that needs it is PR-13's. A settings PR inventing its own blocker would be the second,
  weaker copy MVP-08 §4 rules out. The harness
  leaves the blocker out and says why, so the prompt lands once — with PR-13 — rather than twice.
- **Review round 1 fixed two UI defects this PR shipped** (see the PR discussion, not a §6 criterion):
  - The first draft defined `--color-paper-dark`/`--color-ink-dark` and used them on `<body>` only, so under
    `class="dark"` the `<select>` and both password `<input>`s kept `bg-paper` (`#f8fafc`) and inherited the light
    body text — about 1.1:1. `styles/globals.css` now **redefines the three semantic tokens on `html.dark`**, because
    v4 compiles `bg-paper` to `var(--color-paper)` and `/20` modifiers to `color-mix(… var(--color-ink) …)`: one flip
    repaints every utility that names them, including inside form controls. PR-08's token set should keep that shape
    (names that mean paper/ink, values that depend on the theme) rather than pairing each token with a `-dark` twin
    nothing reads.
  - The error screen is gated on `isError && !hasData`. React Query v5 raises `isError` for a failed **background
    refetch** while keeping `data`, and this screen refetches after every patch, so `isError` alone meant "a `PATCH`
    failed *and* the refetch behind it failed" wiped four working controls, hid the patch error, and discarded
    half-typed passwords. A failed refresh with a row on screen is a note (`settings-refresh-error`) with its own
    retry; only a screen with nothing to show gets replaced.
- **The settings reads validate their body.** `GET /api/settings` needs no `?includeDeleted` (the contract has no
  `SettingsIncludeDeleted`, §9.2 #22), and `SettingsUpdatedAt = z.iso.datetime()` rejects the millisecond-less strings
  a `::text` cast produces — which is a trap on another route, not a reason to skip parsing here. `lib/api.ts` offers
  an unvalidated `text()` escape hatch; `settings.api.ts` deliberately does not take it.
