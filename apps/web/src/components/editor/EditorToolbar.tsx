/**
 * The Markdown toolbar (§5 of docs/plans/mvp/MVP-13.md).
 *
 * Fifteen buttons, and every one of them is a row of `TOOLBAR_ITEMS` rather than a component: the toolbar
 * is a *palette*, and a palette whose items each own state is fifteen places to forget the same three
 * things (`type="button"` so a click inside a future `<form>` cannot submit it, `title` for the chord,
 * `disabled` while the source is out of the way). One `map` over the table the transforms live in means a
 * button cannot exist in the UI without existing in `lib/markdown.ts`, and cannot exist there without a
 * `data-testid` PR-19 can click.
 *
 * A click does not touch React state. It hands the transform to {@link onApply}, which is
 * `EditorPane`'s one-liner over `applyToElement` — the element's caret in, the editing engine out. That
 * indirection is the difference between a toolbar whose bold is undoable and one that overwrites the
 * buffer from outside the browser's editing history.
 *
 * `disabled` is a mode question rather than a busy question: a mutation in flight does not make the source
 * uneditable (PR-14 keeps the buffer live while a write is owed), but `preview` mode really does have no
 * buffer on screen to transform.
 */
import { TOOLBAR_ITEMS } from '../../lib/markdown';

export interface EditorToolbarProps {
  /** Run one transform against the live buffer. The toolbar has no opinion about which element. */
  readonly onApply: (testId: string) => void;
  /** `preview` mode: there is no source on screen, so the buttons that change it say so. */
  readonly disabled?: boolean;
}

export function EditorToolbar({ onApply, disabled = false }: EditorToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Markdown formatting"
      aria-disabled={disabled}
      data-testid="editor-toolbar"
      data-disabled={disabled ? 'true' : 'false'}
      className="flex flex-wrap items-center gap-1"
    >
      {TOOLBAR_ITEMS.map((item) => (
        <button
          key={item.testId}
          type="button"
          // The label is a glyph (`B`, `☐`, ```` `), which is not an accessible name, so the sentence in
          // `hint` is the button's actual name and the glyph is decoration inside it.
          aria-label={item.hint}
          title={item.hint}
          disabled={disabled}
          onClick={() => onApply(item.testId)}
          data-testid={item.testId}
          className="h-8 min-w-8 rounded-md border border-line bg-surface px-2 text-sm font-medium text-ink-muted
            hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand
            disabled:cursor-not-allowed disabled:opacity-50"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
