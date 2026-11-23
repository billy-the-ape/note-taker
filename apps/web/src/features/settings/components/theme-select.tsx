/**
 * The theme picker (docs/plans/mvp/MVP-16.md §5). One `<select>`, three `<option>`s, each with the
 * `settings-theme-*` id PR-19 clicks, and the *stored* value as the selection — never the resolved
 * one, because choosing `system` and having the OS say `dark` must not repaint the control as
 * `dark`: the next OS flip has to keep following.
 */
import type { SettingsTheme } from '@note-taker/contracts';
import type { ResolvedTheme } from '../theme.js';
import { PendingNote } from './form-section.js';
import { SettingRow } from './setting-row.js';

export interface ThemeOption {
  readonly value: SettingsTheme;
  readonly label: string;
  readonly testId: string;
}

/** The three values `settingsThemeSchema` allows, in the order a person reads them. */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'system', label: 'System', testId: 'settings-theme-system' },
  { value: 'light', label: 'Light', testId: 'settings-theme-light' },
  { value: 'dark', label: 'Dark', testId: 'settings-theme-dark' },
];

export interface ThemeSelectProps {
  readonly theme: SettingsTheme;
  /** What `class="dark"` resolved to right now, so `system` can say what it is following. */
  readonly resolved: ResolvedTheme;
  readonly pending: boolean;
  /** `exactOptionalPropertyTypes` is on, so "no error" is passed as an explicit `undefined`. */
  readonly errorMessage?: string | undefined;
  readonly onChange: (theme: SettingsTheme) => void;
}

export function ThemeSelect({
  theme,
  resolved,
  pending,
  errorMessage,
  onChange,
}: ThemeSelectProps): React.JSX.Element {
  return (
    <SettingRow
      title="Theme"
      description="Light, dark, or whatever your operating system prefers. Applies on this page as soon as you choose, and again on every load."
      htmlFor="settings-theme"
    >
      <select
        id="settings-theme"
        data-testid="settings-theme-select"
        disabled={pending}
        value={theme}
        onChange={(event) => {
          onChange(event.target.value as SettingsTheme);
        }}
        className="rounded-md border border-ink/20 bg-paper px-3 py-1.5 text-sm disabled:opacity-60"
      >
        {THEME_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} data-testid={option.testId}>
            {option.label}
          </option>
        ))}
      </select>
      {pending ? <PendingNote label="Saving…" /> : null}
      {theme === 'system' ? (
        <span data-testid="settings-theme-resolved" className="text-sm text-ink-muted">
          {resolved === 'dark' ? 'Following the system: dark' : 'Following the system: light'}
        </span>
      ) : null}
      {errorMessage === undefined ? null : (
        <p aria-live="assertive" data-testid="settings-theme-error" className="text-sm text-red-700">
          {errorMessage}
        </p>
      )}
    </SettingRow>
  );
}
