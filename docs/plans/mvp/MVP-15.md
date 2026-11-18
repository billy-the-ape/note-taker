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
- `@note-taker/contracts` `names.ts`: `NOTE_NAME_MAX = 120`, `newFileName(msEpoch) => \`new-file-${msEpoch}.md\``,
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
