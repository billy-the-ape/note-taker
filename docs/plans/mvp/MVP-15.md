# MVP-15 · PR-15 — New-note dialog with `new-file-<msepoch>.md` prefill

> **Task ID:** `PR-15` · **Branch:** `feat/pr-15-new-note` · **Size:** S (≤ ½ day)
> **Depends on:** PR-12, PR-09, PR-13 (merged) — the acceptance ends with the new note **open in the editor**, so
> `/app/note/$noteId` must already exist
> **Track:** E UI (deliberately separable from PR-12) · **Review gate:** M3

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~16k tokens** | this brief (1.5k as written) + PR-12's dialogs (`RenameDialog` pattern), tree cache/`features/tree/*`, `TopBar`/context menu + `data-testid` conventions + PR-05's `contracts/names.ts` + PR-13's editor route/query wiring |
| **Output** | **~5k tokens** | `components/notes/NewNoteDialog.tsx`, `lib/name.ts` (thin wrapper), wiring in `TopBar`/tree context menu, 2 test files |
| **Session total** | **~21k tokens** | ≈ half an engineer-day (`S`) |

> 1 token ≈ 4 chars; ±30%.

---

## 1. Goal

The README's file-naming rule, done properly: the user is **asked for a name**, pre-filled with
`new-file-<msepoch>.md`, and the **`.md` suffix cannot be edited or deleted**. After creating, the note is open and
focused in the editor.

## 2. Repo state you can assume

- PR-12: `/app` shell, tree with cache (`['tree',userId]`), `TopBar`, tree context menu, shared
  `components/notes/{RenameDialog,MoveDialog,DeleteConfirm}.tsx` patterns, `data-testid`s.
- PR-13: `routes/app/note.$noteId.tsx` + `note.queries.ts` (so the new note can be opened and focused).
- PR-09: `POST /api/notes {name?, folderId|null, content?}` → `201 NoteWithContent`; sibling clash ⇒ `409 CONFLICT`
  **with the existing id**; `name` omitted ⇒ the server generates `new-file-<msepoch>` and uniquifies; cross-user
  `folderId` ⇒ `404`.
- `@note-taker/contracts` `names.ts`: `NOTE_NAME_MAX = 120`, ``newFileName(msEpoch) => `new-file-${msEpoch}.md` ``,
  `stripMd` (drops one trailing `.md`, case-insensitive), `withMd` (display only), `isValidNoteName` (rejects path chars
  `/ \ : * ? " < > |`, control chars, leading/trailing space, `.`/`..`, > 120 chars, **and any stripped name that still
  ends in `.md`**), `uniquify(name, taken)` operating on the extension-free base (`plan` → `plan-2` → `plan-3`).
  `notes.name` in the DB never carries `.md`.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-15`; CI green; never lower a coverage threshold; docs updated here if
you change any documented behavior.

## 4. Files to create

- `apps/web/src/components/notes/NewNoteDialog.tsx`.
- `apps/web/src/lib/name.ts` — a **thin wrapper** over `contracts/names.ts` (no duplicated rules; the single source of
  truth stays in contracts).
- Wire the "New note" buttons: `TopBar`, `StatusBar` (if present), tree context menu.

## 5. Behavior (exact)

- Input value pre-filled with `new-file-<Date.now()>.md`, **caret placed before the `.md`**.
- The `.md` is rendered as a **fixed suffix sibling element** — the input value excludes it, so the suffix cannot be
  edited, deleted, or typed over. Strip it from the submitted name anyway (`stripMd`) as belt-and-braces.
- Target folder defaults to the selected folder (or root when nothing is selected) → `folderId` / `null`.
- Live validation: an invalid-name message from `isValidNoteName`; **Create is disabled** while the name is invalid or
  collides. Uniqueness is checked **debounced against the tree cache** — **no extra endpoint**.
- On create: `POST /api/notes`, optimistic tree update via the existing mutations, then navigate to
  `/app/note/<new id>` and focus the editor.
- If the server answers `409 CONFLICT` (someone else created the same name), show the inline error and keep the dialog
  open with the text intact.
- **No `Ctrl/Cmd+N` binding.** That chord is browser-reserved (Chromium opens a new window/tab before any page handler
  sees it; Firefox/Edge reserve it likewise), so it cannot be intercepted reliably. Keyboard users reach the dialog
  through the same focusable buttons; a chord for it belongs with the palette backlog. Do not add a listener.

## 6. Acceptance criteria (Vitest)

- [ ] Input pre-filled with `new-file-<Date.now()>.md` and the caret sits before `.md`.
- [ ] The `.md` suffix is non-editable (typing/deleting in the input never removes it; the submitted name has no `.md`).
- [ ] Live invalid-name message for: empty, `a/b`, `foo.md.md`, 121 chars, trailing space.
- [ ] Collision against the tree cache disables Create with "name already used in this folder".
- [ ] Creating in the **selected folder** sends the right `folderId`; with nothing selected it sends `null` (root).
- [ ] After create, the note is open in the editor, focused, and the URL changed.
- [ ] A second dialog opened **within the same millisecond** still gets a unique name (`uniquify`, e.g.
      `new-file-1700000000000-2`) — fake the clock to prove it.
- [ ] A server `409` keeps the dialog open with the inline error and the typed text preserved.
- [ ] No keydown listener binds `Ctrl/Cmd+N` (grep + a test asserting the chord does nothing).
- [ ] Coverage unchanged or better; `apps/web/src` ≥ 55/55/50/55.

## 7. Out of scope

New-folder dialog (PR-12 has it), note templates, tags/pinning (backlog), command palette (backlog), any server change.

## 8. PR body template

```
Task: PR-15

## What
NewNoteDialog with new-file-<ms>.md prefill, caret before the fixed .md suffix, debounced tree-cache uniqueness check,
target-folder defaulting, open-in-editor-after-create, lib/name.ts wrapper. No Ctrl/Cmd+N binding (browser-reserved).

## Acceptance evidence
- vitest run: prefill + caret, suffix immutability, disabled Create (invalid + collision), root vs folder target,
  same-millisecond uniquify, 409 keeps dialog open
```

## 9. What landed (record, written by the PR that did the work)

**Neither `Depends on` UI PR was in this tree.** `main` was at **PR-10**: no PR-12 (`/app` shell, `TopBar`,
`StatusBar`, tree context menu, `features/tree/*`, the shared `RenameDialog`/`MoveDialog`/`DeleteConfirm`), no
PR-13 (`routes/app/note.$noteId.tsx`, `features/notes/note.queries.ts`). §2's "you can assume" therefore had to be
substituted in three places, each recorded below, and each substitution is a file the owning PR has to absorb
rather than a decision it can re-make.

| §6 criterion | Where it is asserted |
| --- | --- |
| Prefill `new-file-<Date.now()>.md`, caret before the `.md` | `components/notes/new-note-dialog.test.tsx` → "opens on new-file-\<ms\>.md…": value is extension-free, the suffix is the input's next sibling, `selectionStart === value.length` |
| The `.md` cannot be edited or deleted, and never reaches the body | "survives everything the keyboard can do…": clear, `Backspace`, `Delete`, then typing a name that carries `.md`; the body still says `quarterly report` |
| Live invalid-name message for empty, `a/b`, `foo.md.md`, 121 chars, trailing space | `it.each` over the five §6 values, asserting `aria-invalid`, the disabled button, and that the sentence is `NAME_REJECTION_MESSAGES[…]` verbatim |
| A tree-cache collision disables Create with "name already used in this folder" | "calls a name that is already a sibling…", which also proves the check is debounced (`queryByText` is null synchronously, `NAME_CHECK_DEBOUNCE_MS > 0`) and sent no request |
| Selected folder ⇒ its `folderId`; nothing selected ⇒ `null` | "creates in the selected folder…" / "creates in the root…", asserted on the recorded request body, plus the context-menu row as a third target |
| After create the note is open in the editor, focused, at the new URL | "leaves the dialog, opens the note in the editor…": URL, `document.activeElement`, `data-wants-focus`, the name read back from `['note', id]`, and the metadata-only row in `['tree', userId]` |
| A second dialog in the same millisecond still gets a unique name | "gives a second dialog opened in the same millisecond…", with `Date.now` frozen at `HARNESS_MS`; the second prefill is `new-file-1700000000000-2` |
| A server `409` keeps the dialog open, inline, with the text preserved | "keeps the dialog open, says the server's sentence…": the envelope's own `message` under `new-note-server-error`, the box still holding `shared name`, one request sent |
| No `Ctrl/Cmd+N` binding (grep + the chord does nothing) | "is bound by nothing in this app…" (closed ⇒ opens nothing; open ⇒ no close, no submit, no create, no focus move) and "appears in no source file…" which greps every non-test `.ts`/`.tsx` under `apps/web/src` |
| `apps/web/src` ≥ 55/55/50/55 | `vitest run --coverage`: 98.17 statements / 93.89 branches / 98.02 functions / 99.3 lines, with `src/lib/**` at 98.44/94.05/96.77/99.09 |

- **The three "New note" buttons are not wired, because they do not exist** (§4). `components/layout/TopBar.tsx`,
  `StatusBar.tsx` and `components/tree/TreeContextMenu.tsx` are PR-12's files, listed in the plan's own
  merge-conflict hotspots, and this PR has no business creating an app shell. What it ships instead is the
  affordance PR-12 calls: `useNewNoteDialog()` returns `{ open, target, openFor, close, dialog }`, so `TopBar`
  and `StatusBar` are `<Button onClick={() => newNote.openFor()}>New note</Button>` and a context-menu row is
  `onSelect={() => newNote.openFor({ folderId: folder.id, folderName: folder.name })}`, with `{newNote.dialog}`
  rendered once per host. `test/new-note-harness.tsx` renders all three shapes — plain button, folder-targeted
  button, `role="menuitem"` — which is where §4's wiring is actually proven today.
- **"Uniqueness against the tree cache" reads `['tree', userId]` and nothing else** (`readTreeCache`), with no
  endpoint added. Until PR-12's query writes that key the cache is empty and every name looks free; that is the
  honest reading of "the tab that has not fetched the tree has no opinion", and it is why the `409` branch is
  part of the feature rather than an error path.
- **A created note enters the cache when the server confirms it, not on submit.** §5 asks for "optimistic tree
  update via the existing mutations"; there were no existing mutations, and the one thing this PR cannot fake is
  the id — `POST /api/notes` mints the note's UUIDv7, so an optimistically inserted row would carry a
  client-invented id into `/app/note/<id>`, i.e. a sidebar link that 404s until the response lands. So
  `addNoteToTreeCache` runs in `onSuccess` (metadata only, `noteSchema.parse`, never plaintext in a tree entry)
  alongside `setQueryData(['note', id])`, and the tree is invalidated with `refetchType: 'none'`. Create is
  `disabled`/`loading` while the request is in flight, which is the double-submit guard the optimistic row would
  otherwise have had to be.
- **The editor handoff is `queryKeys.editorFocus`.** PR-15 writes it, PR-13 reads it: `openNoteInEditor()` marks
  `['editor-focus'] = noteId` and navigates, `takesEditorFocus(client, noteId)` is what
  `routes/app/note.$noteId.tsx` asks on mount. It is deliberately *not* consumed — a one-shot read is eaten by
  the first pass of `main.tsx`'s `StrictMode` double-mount, and a caret that only appears in production is a
  worse bug than a sticky one. It is also not a query parameter: "created seconds ago" is not a property of the
  note, and a `?focus=1` would be bookmarked and re-opened.
- **`navigate({ href })`, not `to`.** `/app/note/$noteId` is not in `routeTree.gen.ts` until PR-13 creates the
  file, and `to` is typed against that tree — `NOTE_EDITOR_PATH` is exported so the swap to
  `navigate({ to: NOTE_EDITOR_PATH, params: { noteId } })` is one line, in the same call, with the marking
  unchanged.
- **`apps/web/src/test/new-note-harness.tsx` is a stand-in for PR-12's chrome and PR-13's editor page, and is
  documented as one.** Its `EditorPage` is exactly PR-13's contract (`getQueryData(['note', id])`, focus when
  `takesEditorFocus`); its chrome is exactly the three triggers PR-12 wires. When either PR lands it moves those
  lines into its own files and keeps this harness's assertions — the focus handoff, the URL, and the three
  affordance shapes are PR-15's acceptance evidence, not scaffolding to delete.
- **`data-testid`s this PR adds, in PR-12's naming style, for PR-19:** `new-note-dialog`, `new-note-title`,
  `new-note-target` (the "created in your home folder / in Ideas" sentence), `new-note-name` (the input, also its
  `id`), `new-note-suffix` (the fixed `.md`), `new-note-create`, `new-note-cancel`, `new-note-server-error`
  (the `409`/network line), `new-note-form`. `new-note-name` and `new-note-suffix` are the pair an e2e check needs:
  the assertion "the suffix survived typing" is `suffix.textContent === '.md'` next to
  `input.value === 'quarterly report.md'`.
