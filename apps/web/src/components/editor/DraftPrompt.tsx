/**
 * The restore prompt for the `localStorage` mirror (§6 of docs/plans/mvp/MVP-14.md: "buffer mirrored to
 * `localStorage['note-draft:<id>']` so a browser crash keeps the last text, **with a restore prompt**").
 *
 * It is a separate component from {@link ConflictBanner} because the two states want opposite
 * sentences: a conflict says *somebody else wrote*, this says *you wrote, and it never got there*.
 * Both are "the buffer you are looking at is not the row you think you are editing", and neither may
 * quietly resolve itself — this one offers to put the mirrored text into the buffer (and therefore into
 * the next debounce window, under the version guard, exactly as if it had been typed), or to delete the
 * key. `discard` really does delete it: a fallback that asks again on every visit stops being a fallback
 * and becomes a nag.
 *
 * The prompt itself lives here; the *decision* to show it is `useAutosave().draft`, which is where
 * `draftNeedsRestore` gets to be a pure function with a unit test and no DOM.
 */
import { Button } from '../ui/Button';

export interface DraftPromptProps {
  /** The mirrored text, which the server has never seen. */
  readonly content: string;
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
}

export function DraftPrompt({ content, onRestore, onDiscard }: DraftPromptProps) {
  return (
    <div
      data-testid="draft-prompt"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 rounded-md border border-line bg-paper-2 p-3"
    >
      <p className="text-sm font-medium text-ink">
        This browser kept {content.length.toLocaleString()} characters of this note from a visit that never
        finished saving.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" data-testid="draft-restore" onClick={onRestore}>
          Restore it
        </Button>
        <Button variant="secondary" size="sm" data-testid="draft-discard" onClick={onDiscard}>
          Throw it away
        </Button>
      </div>
      <details className="text-sm text-ink-muted">
        <summary className="cursor-pointer select-none">Show what it kept</summary>
        <pre data-testid="draft-text" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono">
          {content}
        </pre>
      </details>
    </div>
  );
}
