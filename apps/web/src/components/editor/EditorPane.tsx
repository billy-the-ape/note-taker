/**
 * The two panes, the mode buttons, the toolbar and the byte counter — the parts of §5 that are one layout
 * rather than one behaviour.
 *
 * ## The mode is CSS, not a mount
 *
 * Both panes are in the document in every mode, and `modeLayout` decides which one is `hidden`. That buys
 * three things the alternative (conditionally rendering the source) loses: the textarea keeps its caret and
 * its browser undo history across `split → write → split`; the scroll sync below has two elements to talk
 * about when the mode comes back; and a note read in `preview` still has its buffer in the document, which
 * is what PR-19's preview-then-reload assertion reads. The cost is a hidden element in the tree, which is
 * why each pane carries `aria-hidden` when it is the hidden one: a control that is present but unreachable
 * is a different accessibility problem from one that is merely invisible, and the two should not be
 * confused.
 *
 * ## Scroll sync, best effort
 *
 * §5 says best effort and means it: one direction (the source drives the render), one ratio
 * (`scrollTop / scrollable`), no attempt to line a Markdown block up with a source line. The reverse
 * direction is deliberately absent — a listener on the preview would fight the mouse the moment somebody
 * scrolls the rendered half to check a table. It runs in `split` only, because that is the one mode with a
 * pair to keep together.
 *
 * ## The byte counter
 *
 * It renders §5's two numbers and the threshold sentence, and decides nothing: the thresholds live in
 * `lib/note-size.ts`, which is the half §6 asks to unit-test ("do not build a 900 KiB DOM fixture"). The
 * line is the textarea's `aria-describedby`, so the size of a note is something a screen reader hears with
 * the control rather than a fact floating next to it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  defaultModeFor,
  EDITOR_MODES,
  type EditorMode,
  modeLabel,
  modeLayout,
  readEditorMode,
  WIDE_VIEWPORT_QUERY,
  writeEditorMode,
} from '../../lib/editorMode';
import { transformFor } from '../../lib/markdown';
import { counterText, noteSize, sizeWarning } from '../../lib/note-size';
import { EditorToolbar } from './EditorToolbar';
import { applyToElement, MarkdownEditor } from './MarkdownEditor';
import { PreviewPane } from './PreviewPane';

/** The `data-testid` of a mode button, in the `mode-<mode>` shape §5 and PR-19 select. */
export function modeTestId(mode: EditorMode): string {
  return `mode-${mode}`;
}

/** The viewport the default mode depends on, asked honestly when there is no viewport to ask. */
export function matchesWideViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(WIDE_VIEWPORT_QUERY).matches;
}

/** §5's viewport branch, spelled for a caller that wants to say what the default would be today. */
export function defaultMode(): EditorMode {
  return defaultModeFor(matchesWideViewport());
}

export interface EditorPaneProps {
  /** The buffer, from `useAutosave().snapshot.buffer`. */
  readonly buffer: string;
  /** The next buffer — the editor's own `onChange`, and the only way text enters this component. */
  readonly onEdit: (next: string) => void;
  /**
   * Take the caret on mount: PR-15's "after create, the note is open in the editor, **focused**", which is
   * only true when `takesEditorFocus()` said this tab created the note (the page decides that; this
   * component only obeys).
   */
  readonly focusOnMount?: boolean;
  readonly className?: string;
}

/** The editor surface: modes, counter, toolbar, source, render. */
export function EditorPane({ buffer, onEdit, focusOnMount = false, className = '' }: EditorPaneProps) {
  // The stored choice wins; the viewport decides only for a browser that has never chosen. Read once, on
  // purpose: resizing the window is not a reason to overrule a person who picked a mode (§5 persists it).
  const [mode, setMode] = useState<EditorMode>(() => readEditorMode(matchesWideViewport()));
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const layout = modeLayout(mode);
  const size = noteSize(buffer);
  const warning = sizeWarning(size.status);

  useEffect(() => {
    if (focusOnMount) editorRef.current?.focus();
  }, [focusOnMount]);

  const choose = (next: EditorMode): void => {
    setMode(next);
    writeEditorMode(next);
  };

  /**
   * A toolbar click runs the transform against the live element (see `applyToElement`), which is the
   * difference between a bold that Ctrl+Z can take back and one that overwrites the buffer from outside the
   * browser's editing history. Nothing here calls `onEdit`: the `input` event the write fires is what
   * carries the new text to the autosave machine, exactly as a typed character would.
   */
  const apply = (testId: string): void => {
    const transform = transformFor(testId);
    if (transform === undefined) return;
    applyToElement(editorRef.current, transform);
  };

  // Both ends are refs owned by the panes themselves, so the pairing needs no query and no context.
  useEffect(() => {
    if (mode !== 'split') return;
    const source = editorRef.current;
    const preview = previewRef.current;
    if (source === null || preview === null) return;
    const onScroll = (): void => {
      const room = source.scrollHeight - source.clientHeight;
      const previewRoom = preview.scrollHeight - preview.clientHeight;
      if (room <= 0 || previewRoom <= 0) return;
      preview.scrollTop = (source.scrollTop / room) * previewRoom;
    };
    source.addEventListener('scroll', onScroll);
    return () => source.removeEventListener('scroll', onScroll);
    // `mode` is the whole dependency: the effect re-subscribes when the mode changes, and the elements
    // themselves never change (they are never unmounted).
  }, [mode]);

  const columns = useMemo(() => (mode === 'split' ? 'lg:grid-cols-2' : 'grid-cols-1'), [mode]);

  return (
    <div
      className={`flex h-full min-h-0 flex-col gap-2 ${className}`}
      data-testid="editor-pane"
      data-mode={mode}
    >
      <div className="flex flex-wrap items-center gap-2">
        <section aria-label="Editor mode" className="flex items-center gap-1">
          {EDITOR_MODES.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={modeTestId(option)}
              aria-label={modeLabel(option)}
              title={modeLabel(option)}
              // `aria-pressed`, because these are a mode group rather than a tab list: the pane below is the
              // same document whichever is on, and a tablist would promise a panel that swaps.
              aria-pressed={mode === option}
              data-active={mode === option ? 'true' : 'false'}
              onClick={() => choose(option)}
              className={`h-8 rounded-md border px-2.5 text-sm font-medium focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-brand ${
                  mode === option
                    ? 'border-brand bg-brand text-white'
                    : 'border-line bg-surface text-ink-muted hover:bg-paper-2 hover:text-ink'
                }`}
            >
              {option}
            </button>
          ))}
        </section>

        <span className="flex-1" />

        <p
          data-testid="byte-counter"
          data-status={size.status}
          id="editor-byte-counter"
          className="font-mono text-xs text-ink-muted"
        >
          {counterText(size)}
        </p>
      </div>

      {warning === undefined ? null : (
        <p
          data-testid="byte-warning"
          data-status={size.status}
          role="status"
          className="rounded-md border border-danger/30 bg-danger-soft px-2 py-1 text-xs text-danger"
        >
          {warning}
        </p>
      )}

      <EditorToolbar onApply={apply} disabled={mode === 'preview'} />

      <div className={`grid min-h-0 flex-1 gap-3 ${columns}`}>
        <div className="relative min-h-0" data-pane="editor" hidden={!layout.editor}>
          <MarkdownEditor
            ref={editorRef}
            value={buffer}
            onEdit={onEdit}
            hidden={!layout.editor}
            describedBy="editor-byte-counter"
          />
        </div>

        <div className="relative min-h-0" data-pane="preview" hidden={!layout.preview}>
          <PreviewPane ref={previewRef} content={buffer} hidden={!layout.preview} />
        </div>
      </div>
    </div>
  );
}
