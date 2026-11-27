/**
 * The autosave switch (docs/plans/mvp/MVP-16.md §5), `data-testid="settings-autosave-toggle"` for
 * PR-19's e2e run.
 *
 * It is a `role="switch"` button rather than a checkbox because the value is not a form field: one
 * click is one `PATCH`, and the row re-renders from the optimistic cache write rather than from
 * local state. That is the difference between a toggle that lies and one that does not — a locally
 * stateful switch would keep showing "off" after `usePatchSettings` rolled the cache back, and the
 * open editor would still be autosaving.
 */
import { PendingNote } from './form-section.js';
import { SettingRow } from './setting-row.js';

export interface AutosaveToggleProps {
  /** The value from `useAutosaveEnabled()`, so the switch and the editor cannot disagree. */
  readonly enabled: boolean;
  readonly pending: boolean;
  /** `exactOptionalPropertyTypes` is on, so "no error" is passed as an explicit `undefined`. */
  readonly errorMessage?: string | undefined;
  readonly onToggle: (next: boolean) => void;
}

export function AutosaveToggle({
  enabled,
  pending,
  errorMessage,
  onToggle,
}: AutosaveToggleProps): React.JSX.Element {
  const track = enabled ? 'bg-brand' : 'bg-ink/25';
  const knob = enabled ? 'translate-x-5' : 'translate-x-0.5';

  return (
    <SettingRow
      title="Autosave"
      description="Saves the note about a second after you stop typing. Turn this off and the editor only saves when you press Ctrl/Cmd+S or hit Save."
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Autosave"
        data-testid="settings-autosave-toggle"
        disabled={pending}
        onClick={() => {
          onToggle(!enabled);
        }}
        className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${track}`}
      >
        <span
          aria-hidden
          className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${knob}`}
        />
      </button>
      <span aria-hidden className="text-sm text-ink-muted w-8">
        {enabled ? 'On' : 'Off'}
      </span>
      {pending ? <PendingNote label="Saving…" /> : null}
      {errorMessage === undefined ? null : (
        <p aria-live="assertive" data-testid="settings-autosave-error" className="text-sm text-red-700">
          {errorMessage}
        </p>
      )}
    </SettingRow>
  );
}
