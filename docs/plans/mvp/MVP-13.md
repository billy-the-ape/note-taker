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
