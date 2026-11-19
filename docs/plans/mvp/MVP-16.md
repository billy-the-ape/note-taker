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
