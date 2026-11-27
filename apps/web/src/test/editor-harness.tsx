/**
 * A test-only stand-in for PR-14's editor and autosave engine — **not** the engine, and not shipped.
 *
 * Why this file exists: PR-16's first acceptance criterion is a regression test that the autosave
 * flag *round-trips into the open editor* (pill text, zero debounce writes while off, debouncing
 * resumes when it goes back on, `Ctrl/Cmd+S` and the explicit Save button still working). The engine
 * that decides all of that is PR-14's `useAutosave()`, and PR-14 is not merged: writing
 * `lib/autosave.ts` here would claim PR-14's state table, its `VERSION_CONFLICT` fork and its unload
 * budget as done when none of it exists.
 *
 * So this harness implements exactly one rule — the rule PR-14 §6 states about the injected flag, in
 * the two places PR-16 can be blamed for breaking it:
 *
 * | rule (MVP-14 §6)                     | where PR-16 could break it                          |
 * | ------------------------------------ | --------------------------------------------------- |
 * | `autosave: false` ⇒ no debounce write | the flag never reaching the consumer, or arriving late |
 * | `Ctrl/Cmd+S`/Save still work          | a toggle that leaves the editor unable to force a save |
 *
 * and it reads the flag *only* through `useAutosaveEnabled()`, which is PR-16's whole surface. What
 * the tests below assert is therefore the propagation, not PR-14's timers: they fail if the settings
 * row is cached under another key, if the optimistic patch does not reach subscribers, or if a toggle
 * needs a remount or a refetch to be noticed. When PR-14 lands, its own fake-timer suite owns the
 * debounce/backoff/conflict behaviour, and this harness should be replaced by the real pill.
 *
 * One thing it deliberately does *not* fake is MVP-16 §5's dirty-buffer prompt ("Save / Discard /
 * Stay"). That is `useBlocker` inside PR-13's `routes/app/route.tsx`; a blocker written here would be
 * asserted against a router shell that does not exist yet, and would be the second copy PR-16 is not
 * allowed to own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAutosaveEnabled } from '../features/settings/use-settings.js';

/** PR-14 §6's debounce, restated here because the harness has to be plausible about it. */
export const AUTOSAVE_DEBOUNCE_MS = 1_200;
/** PR-14 §6's exact pill copy for the off state, pinned because PR-19 asserts on it. */
export const AUTOSAVE_OFF_COPY = 'Autosave off — Ctrl+S to save';

export interface EditorHarnessProps {
  /** Stands in for `PUT /api/notes/:id/content` (PR-10), which does not exist yet either. */
  readonly save: (content: string) => void;
}

export function EditorHarness({ save }: EditorHarnessProps): React.JSX.Element {
  // The only way this component learns about the setting is PR-16's seam. Nothing is passed in.
  const autosave = useAutosaveEnabled();
  const [buffer, setBuffer] = useState('');
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The save callback has to be current when a timer fires, without re-arming the timer per render.
  const saveRef = useRef(save);
  saveRef.current = save;

  const cancelPending = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const write = useCallback(
    (content: string): void => {
      cancelPending();
      saveRef.current(content);
      setSavedAt(new Date().toISOString().slice(11, 19));
    },
    [cancelPending],
  );

  function onEdit(next: string): void {
    setBuffer(next);
    cancelPending();
    // PR-14 §6: "When `settings.autosave === false` (injected): no debounce writes".
    if (!autosave) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      saveRef.current(next);
      setSavedAt(new Date().toISOString().slice(11, 19));
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function onSaveShortcut(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    // PR-14 §6: `Ctrl/Cmd+S` and the explicit Save button keep working while autosave is off.
    event.preventDefault();
    write(buffer);
  }

  const pill = !autosave ? AUTOSAVE_OFF_COPY : savedAt === undefined ? 'Unsaved changes' : `Saved ${savedAt}`;

  return (
    <div className="flex flex-col gap-2" data-testid="editor-harness">
      <textarea
        data-testid="editor-buffer"
        value={buffer}
        onChange={(event) => {
          onEdit(event.target.value);
        }}
        onKeyDown={onSaveShortcut}
      />
      <button
        type="button"
        data-testid="editor-save-button"
        onClick={() => {
          write(buffer);
        }}
      >
        Save
      </button>
      <p data-testid="save-status">{pill}</p>
    </div>
  );
}
