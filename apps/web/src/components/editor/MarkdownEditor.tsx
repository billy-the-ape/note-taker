/**
 * The buffer: a `<textarea>`, its Markdown keymap, and the one place a toolbar transform meets the DOM
 * (docs/plans/mvp/MVP-13.md §5).
 *
 * ## Why a textarea, when the brief names CodeMirror
 *
 * The plan anticipated this exact fork. Risk **R7** of the full plan is "Tailwind v4 / CodeMirror API
 * churn", and its mitigation reads "pinned versions, thin wrappers, **textarea fallback in PR-13**";
 * MVP-13 §Token-estimate repeats it — "document the textarea fallback in the PR body if CodeMirror blocks
 * a test". PR-19's acceptance suite is that test, and it blocks in a way no wrapper can paper over:
 * `e2e/autosave.spec.ts` asserts `expect(page.getByTestId('editor')).toHaveValue('first line\n')`, and
 * Playwright's `toHaveValue` throws `Not an input element` for anything that is not an
 * `<input>`/`<textarea>`/`<select>` — a CodeMirror surface is a `contenteditable` div, so the scenario
 * that proves the MVP autosave story cannot pass on one. PR-19's own header describes the missing page as
 * the one that "owns the **textarea** (`editor`)". Between the two, the hook the acceptance proof selects
 * through is a form control, so the editor is a form control.
 *
 * Everything else the brief asked of `MarkdownEditor` is here and none of it needed a library: the
 * Markdown language mode is what `lib/markdown.ts`'s transforms are for; soft wrap is a textarea's default
 * (`wrap="soft"`); line numbers off is the absence of a gutter; `aria-label="note content"` and the three
 * chords are below. A syntax-highlighting theme, and the `@codemirror/*` pair of dependencies, are the
 * things this file does without — and the browser's own undo stack, which is next, is the one thing it
 * gets *better* than a wrapper around it.
 *
 * ## Native undo
 *
 * A transform must not replace `textarea.value` behind the browser's back: that would leave Ctrl+Z
 * restoring a keystroke from five minutes ago while the bold you just applied was unrecoverable. So
 * {@link applyToElement} selects the text it means to replace and inserts the replacement with
 * `document.execCommand('insertText')` — deprecated as an API, and still the only way to put text into a
 * textarea *through the browser's own editing engine*, which is what records the undo entry and fires the
 * `input` event React listens to. Selection is then moved to where the transform said it should be, so
 * undo takes back the text and the caret together.
 *
 * The `execCommand` fallback below is for an environment with no editing engine at all (jsdom, which is
 * where most of this file's coverage lives): it writes the value and dispatches the same `input` event, so
 * the buffer still arrives at the autosave machine. It is one branch, and it is the branch a real browser
 * never takes.
 */
import type { KeyboardEvent, Ref } from 'react';

import { type Caret, EDITOR_KEYMAP, type Transform, transformFor } from '../../lib/markdown';

/** §5's accessible name for the buffer, spelled once because PR-19 selects through it. */
export const EDITOR_ARIA_LABEL = 'note content';
/** The `data-testid` PR-19 fills, clicks and reads the value of. */
export const EDITOR_TEST_ID = 'editor';

export interface MarkdownEditorProps {
  /** The buffer, which is `useAutosave().snapshot.buffer` — one owner for one string (PR-14 §7). */
  readonly value: string;
  /** The next buffer, from the `input` event a real edit fires. */
  readonly onEdit: (next: string) => void;
  /**
   * `false` in `preview` mode, where the source is out of the way.
   *
   * The textarea stays in the document either way (see `EditorPane`), so the caret and the browser's undo
   * history survive a mode switch; what `hidden` costs it is the caret, and that is the cheaper loss.
   */
  readonly hidden?: boolean;
  readonly describedBy?: string;
  readonly className?: string;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

/** The editor: a textarea with the buffer in it and the §5 chords on its keydown. */
export function MarkdownEditor({
  value,
  onEdit,
  hidden = false,
  describedBy,
  className = '',
  ref,
}: MarkdownEditorProps) {
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Only the plain chord: `Ctrl/Cmd+Shift+B` is somebody else's, and `Ctrl/Cmd+S` belongs to the
    // autosave engine (PR-14), which listens on the document and must not be pre-empted here.
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const chord = event.key.toLowerCase();
    if (chord !== 'b' && chord !== 'i' && chord !== 'k') return;
    const transform = transformFor(EDITOR_KEYMAP[chord]);
    if (transform === undefined) return;

    // **The keymap is scoped to the editor** (§5), and `stopPropagation` is the whole mechanism: while the
    // buffer has focus, `Ctrl/Cmd+K` inserts a link here and the shell's global search chord (PR-17) never
    // hears the key. A document-level listener in the bubble phase cannot fire past this call, which is why
    // PR-17's precedence rule needs nothing extra from this file beyond stopping.
    event.preventDefault();
    event.stopPropagation();
    applyToElement(event.currentTarget, transform);
  }

  return (
    <textarea
      ref={ref}
      data-testid={EDITOR_TEST_ID}
      aria-label={EDITOR_ARIA_LABEL}
      aria-describedby={describedBy}
      aria-hidden={hidden || undefined}
      // `hidden` rather than unmounting, and `readOnly` is not the tool: a control that is present but
      // unreachable is the one accessibility mistake a mode switch must not make.
      hidden={hidden}
      wrap="soft"
      spellCheck={false}
      // The buffer is the autosave machine's (`snapshot.buffer`), so this is a controlled field with
      // nothing local on top of it: a `useState` here would be a second owner of one string, and PR-14's
      // in-flight comparison only means something while there is one.
      value={value}
      onChange={(event) => onEdit(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Write Markdown. **bold**, - lists, | tables |, [links](https://…)."
      className={`h-full w-full resize-none rounded-md border border-line bg-surface p-3 font-mono text-sm
        leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
    />
  );
}

/**
 * Apply a transform to a live textarea: read the caret out of the element, run the pure function, and put
 * the result back through the editing engine.
 *
 * Exported because `EditorToolbar` and the keymap above are two callers of one operation, and a toolbar
 * button that updated React state directly would be the silent loss of the undo history this file exists
 * to keep.
 */
export function applyToElement(element: HTMLTextAreaElement | null, transform: Transform): boolean {
  if (element === null) return false;
  const selection: Caret = { start: element.selectionStart, end: element.selectionEnd };
  return write(element, transform(selection, element.value));
}

/**
 * Put `text` in the element and move the caret, keeping the browser's undo stack honest.
 *
 * `false` means "nothing changed", which is a real answer: toggling bold on text that is not bold and on
 * a caret with nothing next to it can produce the buffer it started with, and reporting that as a change
 * would dirty a note nobody edited (PR-14's `dirty` means *newer than the row*).
 */
export function write(element: HTMLTextAreaElement, applied: { text: string; selection: Caret }): boolean {
  const length = applied.text.length;
  const start = Math.min(Math.max(applied.selection.start, 0), length);
  const end = Math.min(Math.max(applied.selection.end, start), length);
  if (applied.text === element.value && start === element.selectionStart && end === element.selectionEnd) {
    return false;
  }

  element.focus();
  // Replace the whole buffer with one insert, so the whole transform is one undo step.
  element.setSelectionRange(0, element.value.length);
  const inserted = insertThroughEngine(element, applied.text);
  if (!inserted) {
    setValue(element, applied.text);
    // The event React listens to. A direct `value` write does not produce one of its own, and without it
    // the buffer would silently disagree with the machine that owns it — in jsdom, where there is no
    // editing engine, this is the only path and it is the one the tests run on.
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  element.setSelectionRange(start, end);
  // Exactly one hand-off either way: the browser path fires `input` too, and React's `onChange` is what
  // carries the new buffer to `useAutosave().edit`. Returning the fact rather than the text keeps this
  // file free of a second owner of the string.
  return true;
}

/**
 * Write the buffer through the **prototype's** setter rather than the node's.
 *
 * React keeps its own record of a controlled field's value to decide whether an `input` event is worth an
 * `onChange`, and it installs that record as an own property on the element — so `element.value = text` runs
 * through the record-keeper too, the record agrees with the DOM, and the event dispatched a microsecond later
 * is dismissed as "nothing changed". The transform then looks like it worked (the text is on screen) while
 * the buffer it was supposed to hand to PR-14 never moved — a toolbar bold that repaints the pane and does not
 * dirty the note, which is the worst kind of lost edit because the pill says Saved. Reaching past the own
 * property to the prototype's own accessor is the documented way out, and it is exactly what
 * `fireEvent.change` does for the same reason.
 */
function setValue(element: HTMLTextAreaElement, text: string): void {
  const accessor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as HTMLTextAreaElement,
    'value',
  )?.set as ((value: string) => void) | undefined;
  if (accessor === undefined) {
    // No accessor to reach past (an unusual engine, or a stubbed element): the plain write still puts the
    // text on screen, and a caller that cares about the event has the `input` dispatch above it.
    element.value = text;
    return;
  }
  accessor.call(element, text);
}

/**
 * `document.execCommand('insertText')` — the browser's own edit path, and `false` where there isn't one.
 *
 * Some engines throw on an unsupported command rather than returning false, and a toolbar click must never
 * become an unhandled error in a note editor, so both answers mean "use the plain write".
 */
function insertThroughEngine(element: HTMLTextAreaElement, text: string): boolean {
  const doc = element.ownerDocument;
  if (typeof doc.execCommand !== 'function') return false;
  try {
    return doc.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}
