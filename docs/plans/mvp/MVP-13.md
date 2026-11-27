# MVP-13 · PR-13 — Markdown editor pane + toolbar + preview

> **Task ID:** `PR-13` · **Branch:** `feat/pr-13-editor` · **Size:** L (3–4 days) · **Depends on:** PR-12, PR-10 (merged)
> **Track:** E UI · **Review gate:** M3 (with PR-14…17) · **Unblocks:** PR-14, PR-15, PR-17
> **ADR:** ADR-0003 (editor mode: raw Markdown + preview + toolbar) is written by **PR-20**; this PR implements it.

Self-contained work order — everything you need is below; do not load `MVP-FULL-PLAN.md`.

## Token estimate

| Direction | Estimate | What it covers |
| --- | --- | --- |
| **Input** | **~25k tokens** | this brief (1.8k as written) + PR-12's `routes/app/route.tsx`, layout components and `data-testid` conventions + PR-10/PR-09's note endpoints (`GET /api/notes/:id` → `{…NoteNode, content, version}` + `ETag`) + CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/lang-markdown`, state/transaction APIs) + react-markdown/remark-gfm/rehype-sanitize docs + jsdom quirks |
| **Output** | **~15k tokens** | `components/editor/{EditorPane,MarkdownEditor,EditorToolbar,PreviewPane}.tsx`, `routes/app/note.$noteId.tsx`, `lib/markdown.ts`, `features/notes/{note.queries.ts,note.mutations.ts}` (read side), ~4 test files (the transform table is the bulk) |
| **Session total** | **~40k tokens** | ≈ one `L` engineer-day; budget ~52k if CodeMirror selection/undo wiring needs extra iterations |

> 1 token ≈ 4 chars; ±30%. Version churn risk (risk R7): versions are pinned; keep wrappers thin (`components/ui`,
> `lib/markdown.ts`) and document the textarea fallback in the PR body if CodeMirror blocks a test.

---

## 1. Goal

Open a note by URL and edit it as **raw Markdown** with a Markdown-aware toolbar and a live sanitized preview.
**No persistence wiring** — the editor holds a buffer and PR-14 attaches autosave to it. No WYSIWYG.

## 2. Repo state you can assume

- `/app` shell (PR-12): `routes/app/route.tsx` (auth guard), `AppShell`/`Sidebar`/`TopBar`/`StatusBar`, the folder tree
  with `data-testid`s, and `features/tree/*`.
- Server: `GET /api/notes/:id` → `{…NoteNode, content, version}` with `ETag: W/"v<version>"` (PR-09);
  `PUT /api/notes/:id/content {content, baseVersion}` (PR-10) — **do not call it yet**; PR-14 wires it.
  Note payload cap is 1 MiB; **the UI warns at 900 KiB**.
- `contracts`: `noteSchema`, `contentUpdateSchema`, `withMd()` for display, `ROUTES`.
- `lib/api.ts` + `queryClient.ts` (cache key `['note',id]`), Tailwind tokens, `components/ui/*`.
- **PR-15 already opens notes.** `features/notes/open-note.ts` marks `['editor-focus'] = noteId` and navigates to
  `/app/note/<id>`; this PR's page has to read it (see §5), and PR-15 navigates with `navigate({ href })` because
  `to` is typed against a route that did not exist yet — `NOTE_EDITOR_PATH` is exported for the swap to
  `navigate({ to: NOTE_EDITOR_PATH, params: { noteId } })`. Its `apps/web/src/test/new-note-harness.tsx` holds the
  two lines (read `['note',id]`, focus on the mark) as an executable version of that contract: move them into
  `routes/app/note.$noteId.tsx` and keep the assertions (MVP-15 §9).
- Pinned editor/markdown deps: CodeMirror 6 via `@uiw/react-codemirror` + `@codemirror/lang-markdown`,
  `react-markdown`, `remark-gfm`, `rehype-sanitize`.

## 3. Global PR rules

Conventional-commit title; PR body starts `Task: PR-13`; CI green; never lower a coverage threshold
(`apps/web/src/lib` row is 80/80/75/80 — `lib/markdown.ts` lives there, so it must be well covered); docs updated in the
same PR if commands/layout change.

## 4. Files to create

- `apps/web/src/routes/app/note.$noteId.tsx` — the editor page (deep linkable).
- `apps/web/src/components/editor/{EditorPane,MarkdownEditor,EditorToolbar,PreviewPane}.tsx`.
- `apps/web/src/lib/markdown.ts` — the toolbar transforms: **pure functions** `(selection, text) => {text, selection}`,
  unit-tested without a DOM.
- `apps/web/src/features/notes/{note.queries.ts,note.mutations.ts}` — `queryOptions` for a note (read side now; the
  mutation helpers stay thin so PR-14 can own the write path).

## 5. Behavior

**`MarkdownEditor`** — CodeMirror 6 with the Markdown language extension, soft wrap, line numbers off,
`aria-label="note content"`, `Cmd/Ctrl+B/I/K` shortcuts. **The keymap is scoped to the editor:** while it has focus
`Cmd/Ctrl+K` inserts a link *there*, and the shell's global search chord (PR-17) must not fire — PR-17 asserts that
precedence.

**`EditorToolbar`** buttons (each one a pure transform in `lib/markdown.ts`, applied as a CodeMirror transaction so
native undo history stays intact): H1, H2, H3, bold, italic, strikethrough, inline code, code block, blockquote, bullet
list, numbered list, task list, link, table, horizontal rule.

**`PreviewPane`** — `react-markdown` + `remark-gfm` + `rehype-sanitize`; scroll-synced (best effort) in split mode.
Sanitization is a security requirement: **no raw HTML, no `javascript:` URLs, `rel="noopener"` on links.**

**Modes** — `split | write | preview` button group, persisted in the `ui` store. Default `split` at ≥ 1024 px, `write`
below.

**Frontmatter** is treated as ordinary text in the MVP (preserved, never parsed).

**Guards & counters** — navigating away with an unsaved buffer prompts (the autosave-off dirty guard "Save / Discard /
Stay" is formalized by PR-14; here it must at least not silently drop text). Character/byte counter with a warning at
900 KiB (`MAX_NOTE_BYTES` = 1 MiB is the server cap).

**The caret** — on mount the page asks `takesEditorFocus(client, noteId)` (`features/notes/open-note.ts`) and, when
that is `true`, focuses the editor: "after create, the note is open in the editor, **focused**, and the URL changed" is
PR-15's acceptance criterion, and the caret lives here. The predicate is a read rather than a one-shot consume, so
`StrictMode`'s double-mount in development still sees it, and a note merely *visited* (tree click, back button, shared
link) must not steal it.

**`data-testid`s for PR-19:** `editor`, `editor-toolbar`, `preview`, `mode-split`, `mode-write`, `mode-preview`,
`save-status` (render a placeholder pill — PR-14 fills it), `byte-counter`, `note-title`.

## 6. Acceptance criteria

- [ ] `lib/markdown.ts` unit tests for **every** toolbar transform, including the awkward cases: toggle bold on
      already-bold (unwrap), selection spanning list items, link wrapping both URL and text (`[text](url)`), table
      insertion at an empty line, empty selection at EOF, CJK/emoji-safe slicing (never split a code point).
- [ ] Preview sanitizes `<script>`, inline `onclick`, and `javascript:` hrefs (assert the rendered DOM).
- [ ] GFM tables and task lists render.
- [ ] A note opens by **direct URL** (`/app/note/$noteId`) and by tree click; the tree selection and the URL agree.
- [ ] CodeMirror transactions keep **native undo** working (bold → undo restores the exact original text and selection).
- [ ] Mode switch persists across reload; default depends on the viewport width (jsdom: assert the branch).
- [ ] Byte counter warns at 900 KiB (unit-test the threshold logic; do not build a 900 KiB DOM fixture).
- [ ] Navigating away with an unsaved buffer does not silently lose the text (prompt path asserted).
- [ ] `apps/web/src/lib` coverage ≥ 80/80/75/80; `apps/web/src` overall ≥ 55/55/50/55.

## 7. Manual acceptance (put screenshots/GIF in the PR body)

Toolbar clicks feel instant; preview matches the Markdown; split mode scroll sync is acceptable. Automation covers the
transform semantics; these two things are what manual checking is for.

## 8. Out of scope

Persistence/autosave wiring (PR-14 — including the save-status pill content and the conflict banner), WYSIWYG
(backlog PR-22), syntax-highlighting themes beyond the default, Mermaid/KaTeX, frontmatter parsing.

## 9. PR body template

```
Task: PR-13

## What
routes/app/note.$noteId, EditorPane/MarkdownEditor/EditorToolbar/PreviewPane, lib/markdown.ts pure transforms,
split|write|preview modes, sanitize via rehype-sanitize, byte counter + 900 KiB warning, unsaved-navigation guard.

## Acceptance evidence
- vitest run: transform table (bold toggle, list-spanning selection, link, table, EOF, CJK/emoji), sanitization DOM,
  undo integrity, mode persistence
- screenshot/GIF: toolbar + live preview in split mode
```

---

## 9. What PR-13 actually shipped, where it differed from this brief

Implemented on `feat/pr-13-editor`. Four decisions moved during implementation; each is a plan change, so it is
recorded here rather than only in code comments.

1. **No CodeMirror: the buffer is a `<textarea>`.** §5/§4 named CodeMirror as the editor and this brief's own risk
   section said "if the spike fails, ship a `<textarea>`". The spike was not a bundle-size question but a contract
   question: PR-14's autosave owns the buffer and its flush triggers (`blur`, `visibilitychange`, `pagehide`,
   `beforeunload`, `Ctrl/Cmd+S`), PR-14's spec suite asserts the buffer with plain DOM values, and PR-19 wrote its
   e2e assertions as `page.getByTestId('editor').fill(...)`/`toHaveValue(...)` — all of which are textarea
   semantics. A textarea with no third-party editor library keeps every one of those true and adds nothing to
   install; `MarkdownEditor.tsx` is ~180 lines and `lib/markdown.ts` is pure. If a later PR wants syntax colouring
   or a per-token decoration, this is the file it will replace and the transforms will not move.
2. **`note-title` is a heading, not a field.** §5 called it "an editable title field" while §4/PR-12 give rename to
   the tree, and AGENTS' one-renderer rule names two inputs writing one row as the bug. The acceptance criterion —
   "`note-title` shows the renamed note in the tree **without a reload**" — is satisfied by reading the name from
   `['tree', userId]` (invalidated by rename), which is what the heading does.
3. **PR-12's note summary moved here, with its test ids.** `routes/app/index.tsx`'s own header predicted this
   ("when PR-13 adds `routes/app/note.$noteId.tsx`, this page keeps the recent list and loses the summary").
   `openNote` is a navigation now, `openedNote` is derived from the location, and `app-note-summary` /
   `app-note-location` / `app-note-facts` / `app-note-close` render on the note page, so `folders.spec.ts` and
   `notes.spec.ts` keep their meaning. `app-note-location` deliberately stays the id PR-12 pinned rather than
   growing a second breadcrumb under §5's `note-location`; PR-17 wants `breadcrumbFor()`, which is exported.
4. **Three e2e assertions became `toHaveValue`.** `toContainText` reads text nodes and a textarea's text is its
   `value`; PR-19 wrote them before the control existed. `preview`'s `<strong>` count is asserted **before** the
   toolbar click, because a bare `click()` inside a textarea puts the caret at a coordinate rather than on a
   selection, and "the button reached the buffer" is honestly a changed value.

Not done, deliberately: `byte-counter`/`editor` have no e2e case of their own yet (the unit tests cover the
thresholds and the DOM test covers the line; §6's 900 KiB fixture stays out of the browser), and the note editor
has no keyboard-only "focus the buffer" affordance beyond the click/Enter path PR-12 shipped.
### Review round 1 (CI `e2e`, `97dfb08` → `ba9717b`)

Two of this PR's own assertions failed in CI because they were written against controls they had not read: the
conflict spec expected the version without the banner's `v` prefix, and the preview spec counted two
`<strong>`s where Markdown renders one `<strong>` and one `<h1>`. Both were fixed against the components, and
`editor-pane.test.tsx` now pins the two element counts at component level so a browser-only assertion has a
local witness.

### Review round 2 (CI `e2e` + reading, `ba9717b`)

Four more, two of them real bugs in the new source rather than in a spec:

- **`e2e/notes.spec.ts` needed its own account.** The naming-rule describe resets the instance once in
  `beforeAll` and registration is unique on `username`, so a second `signInNewAccount` with the same key is a
  guaranteed `409` — not retry noise, as an earlier comment on this PR claimed. `ACCOUNT.noteRender` is now
  scenario 2's second account, with the rule written down in `e2e/fixtures.ts` and AGENTS.
- **A spec cannot click a CSS-hidden pane.** Moving the preview assertion before the toolbar step left the
  source hidden, so the later `editor.click()` waited out Playwright's timeout on an invisible textarea. The
  case now switches back with `mode-write`, asserts `toBeVisible`, and flushes with `Ctrl/Cmd+S` before the
  reload — which also makes "the text is still there after a reload" a claim about the row rather than about
  this tab's draft mirror, and keeps the reload from becoming a native leave-site prompt that Playwright
  dismisses.
- **`taskList` ticked a box it was only meant to fill in** (`lib/markdown.ts`): in `'add'` mode a line that
  already had a marker fell through to the checked branch, so `- [ ] a\nplain` became `- [x] a\n- [ ] plain` —
  silently finishing somebody's item and rewriting their marker. `'add'` now returns the line untouched;
  `'check'` (every touched line a task item, at least one open) is the mode that ticks. The mixed-selection
  case, the `*`-marker case and the should-tick case are unit-tested side by side.
- **"Save as a new note" was blocked by this PR's own guard** (`useAutosave.saveAsNewNote`): it created the row
  and cleared the draft mirror, but the machine stayed `dirty`, so the navigation into the rescued note opened
  the `Save / Discard` prompt instead — offering a write to the deleted row and the adoption of its content.
  `saveAsNewNote` now `adopt`s the created row (`stopped` stays set: that row is gone); `note-editor.test.tsx`
  drives the whole banner flow and asserts the arrival at the new note, which is also the first route test to
  exercise a note that dies while it is open — the tree fake grew `PUT /api/notes/:id/content` and
  `POST /api/notes` for it, so the write path is answered as a server answers it instead of with a `500`.
