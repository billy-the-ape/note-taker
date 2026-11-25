# MVP-12 · PR-12 — App shell + folder tree UI (browse, create, rename, move, delete)

> **Task ID:** `PR-12` · **Branch:** `feat/pr-12-tree-ui` · **Size:** L (3–4 days)
> **Depends on:** PR-08, PR-09 (merged) · **Track:** E UI · **Unblocks:** PR-13, PR-15, PR-17
> **Speed note:** `msw`-style handlers built from `packages/contracts` let you start the moment PR-09's shapes exist.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~25k tokens** | this brief (2.1k as written) + PR-08's `components/ui/*`, `features/auth/*`, `routes/__root.tsx` + PR-05's `lib/api.ts`/`queryClient.ts` + contracts tree/folders/notes schemas + PR-09's endpoint behavior + TanStack Router layout/`route.tsx` and Query mutation APIs + testing-library/jsdom output |
| **Output** | **~17k tokens** | `routes/app/{route.tsx,index.tsx}`, 4 layout components, 4 tree components, 3 shared dialog components, `features/tree/{tree.queries.ts,tree.selectors.ts,tree.mutations.ts}`, server `plugins/static-spa.ts`, deleting `routes/welcome.tsx`, ~6 test files (selector units + component tests) |
| **Session total** | **~42k tokens** | ≈ one `L` engineer-day; budget ~55k with keyboard-nav/a11y polish and the 500-node render check |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

The working application surface: an auth-guarded `/app` shell with a folder tree you can browse, create, rename, move and
delete — plus the server serving the built SPA from the API port. This PR also **deletes `routes/welcome.tsx`** and
repoints every authed landing/redirect at `/app` (the hand-off from PR-08's placeholder, which is why the `/app`
assertions live here and not in PR-08).

## 2. Repo state you can assume

- PR-08 gave: `features/auth/{session.tsx,auth.api.ts,useSession.ts}`, `components/ui/{Button,Input,Field,Dialog,Menu,
  Toast,Spinner}.tsx`, Tailwind tokens, `/setup`, `/login`, `/signup`, `/welcome`.
- PR-05 gave `lib/api.ts` (typed `json()`, `ApiError`, CSRF header, one-shot 403 replay) and `queryClient.ts`
  (cache keys `['tree',userId]`, `['note',id]`, `['settings']`).
- PR-09's server endpoints: `GET /api/tree` → `{folders:[FolderNode], notes:[NoteNode]}` (metadata only, **no
  content**; folders-then-notes, `name` collation `C`), `POST /api/folders {name,parentId|null}`,
  `PATCH /api/folders/:id {name?,parentId?}`, `DELETE /api/folders/:id?cascade=true`,
  `POST /api/notes {name?,folderId|null,content?}`, `PATCH /api/notes/:id {name?,folderId|null}`,
  `DELETE /api/notes/:id`. Errors use the envelope (`{error:{code,message,details?,requestId}}`), sibling clash ⇒
  `CONFLICT` **with the existing id**, cycle ⇒ `CONFLICT`, depth cap ⇒ `VALIDATION`, cross-user id ⇒ `404`,
  non-empty folder delete without `cascade=true` ⇒ `CONFLICT`.
- Tree depth is server-capped at 100 levels (root = depth 0); the server rejects, it never truncates silently.
- Web Vitest config currently has an overall `apps/web/src` threshold row 55/55/50/55 (armed by PR-16; plan §14).

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-12`; CI green; never lower a coverage threshold; docs updated in the
same PR (routes table in `docs/ARCHITECTURE.md` doesn't exist yet — update `README.md`/`docs/API.md` if behavior is
documented there; **`AGENTS.md` gains the `static-spa` layout convention if it describes the layout**).

## 4. Files to create / modify

**Create**

- `apps/web/src/routes/app/route.tsx` — the layout route (TanStack Router's file-based convention: `route.tsx` inside
  the directory wraps `index.tsx`, `note.$noteId.tsx`, `settings.tsx`, `search.tsx`; **`__layout.tsx` is the Next.js
  habit and is not what the plug-in picks up**). The **auth guard lives here** in `beforeLoad` reading the session
  context — never per page.
- `apps/web/src/routes/app/index.tsx` — "no note selected" / recent notes view.
- `apps/web/src/components/layout/{AppShell,Sidebar,TopBar,StatusBar}.tsx`.
- `apps/web/src/components/tree/{FolderTree,FolderRow,NoteRow,TreeContextMenu}.tsx`.
- `apps/web/src/components/notes/{RenameDialog,MoveDialog,DeleteConfirm}.tsx` — shared dialog forms reused by PR-15/16.
- `apps/web/src/features/tree/{tree.queries.ts,tree.selectors.ts,tree.mutations.ts}`.
- `apps/server/src/plugins/static-spa.ts` — serve `apps/web/dist` with an SPA fallback for non-`/api` GETs, so the built
  SPA is served from the API port (one port = "assigned to a port"). Register it in `buildApp()` (add-only edit).

**Delete:** `apps/web/src/routes/welcome.tsx`, and repoint every authed landing/redirect from `/welcome` to `/app`.

## 5. Behavior

- **Tree:** expand/collapse persisted per session; alphabetical, reorder-free; notes shown under their folder with the
  `.md` suffix visible (`withMd()` from contracts — the DB never stores it); empty state; loading skeletons; error toasts
  with retry.
- **Keyboard:** ↑ ↓ ← →, `Enter` open, `F2` rename, `Del` delete. Everything reachable by keyboard.
- **A11y:** `role="tree"` on the container, `role="treeitem"` + `aria-selected` + `aria-expanded` on rows.
- **Context menu:** "New folder" (inline form), "Rename", "Move to…" (folder-tree picker), "Delete".
  Destructive actions (folder with children, note delete) require **typing the item name** to confirm; a folder delete
  sends `cascade=true` only after that confirmation.
- **Mutations:** TanStack Query mutations with optimistic tree updates and rollback on error; a `CONFLICT` on rename
  shows an **inline** error in the dialog (not just a toast). Move into own descendant is blocked **client-side** (using
  the tree cache) *and* surfaced if the server rejects anyway.
- **`data-testid` on everything a UI test needs to assert** — PR-19's e2e suite relies on them. Name them now:
  `tree`, `folder-row-<id>`, `note-row-<id>`, `new-folder`, `rename-dialog`, `move-dialog`, `delete-confirm`,
  `delete-confirm-name-input`, `topbar`, `statusbar`, `sidebar`.
- State model: server state in Query; transient UI (dialogs, sidebar width, preview mode) local + a tiny `ui` store
  persisted in `localStorage`. No Redux/Zustand.

## 6. Acceptance criteria (Vitest + testing-library)

- [ ] Tree selectors (flatten / sort / indent / ancestors / descendant test) unit-tested as pure functions.
- [ ] Rename: optimistic update, then rollback with an inline error on `409`.
- [ ] Move into own descendant blocked client-side; and when the server rejects a move anyway, the error is surfaced and
      the tree reverts.
- [ ] Delete cascade requires the exact typed name (button disabled until it matches).
- [ ] `GET /api/tree` renders nested folders + notes with `.md` visible; root-level folders and root-level notes render.
- [ ] Keyboard nav: arrows move focus, `Enter` opens, `F2` opens rename, `Del` opens delete.
- [ ] A11y roles/attributes present (`tree`, `treeitem`, `aria-selected`, `aria-expanded`).
- [ ] Tree renders **500 nodes in < 150 ms** (jsdom smoke test; log the number in the PR body).
- [ ] `/app` is guarded: unauthenticated visits redirect to `/login` (or `/setup` when `needsSetup`), and **no route
      lands on `/welcome` anymore** (the file is deleted).
- [ ] Server: `GET /` on the API port serves the built SPA and deep links (e.g. `/app`) fall back to `index.html`, while
      `/api/*` is never swallowed by the fallback.
- [ ] Coverage: `apps/web/src` overall ≥ 55/55/50/55 still green; nothing lowered.

## 7. Out of scope

The editor pane (PR-13), the new-note dialog (PR-15), search UI (PR-17), settings UI (PR-16), drag-and-drop (backlog —
MVP moves via dialog), soft delete/trash (backlog PR-23).

## 8. PR body template

```
Task: PR-12

## What
/app layout route with auth guard, AppShell/Sidebar/TopBar/StatusBar, folder tree (browse/create/rename/move/delete with
typed-name confirm), features/tree queries+selectors+mutations, shared Rename/Move/DeleteConfirm dialogs,
apps/server plugins/static-spa.ts, routes/welcome.tsx deleted and redirects repointed to /app.

## Acceptance evidence
- vitest run: selectors, optimistic rollback on 409, client-side descendant block, typed delete, keyboard nav, a11y roles
- 500-node render timing: <n> ms (<150)
- curl the API port: / serves index.html, /app falls back, /api/health untouched
```
