/**
 * `/app/settings` (docs/plans/mvp/MVP-16.md), the screen that owns four things and no more: the
 * autosave switch, the theme select, the change-password form, and "sign out everywhere".
 *
 * What the page deliberately does **not** hold is state. Every value it shows comes from
 * `queryKeys.settings` and every change goes out through `usePatchSettings`, so the switch on this
 * screen and an editor open in the same tab read one cache entry — which is why flipping autosave is
 * felt by the open editor in the same render rather than on the next navigation (§5's
 * "effective immediately in an already-open editor").
 *
 * The page renders the controls against {@link DEFAULT_SETTINGS} while the first read is in flight:
 * `GET /api/settings` is get-or-create (PR-09), so the row a fresh account gets back *is* what is
 * already on screen, and a skeleton that flashes the same four defaults is a worse version of the
 * same wait.
 */

import { ApiError } from '../../lib/api.js';
import { AutosaveToggle } from './components/autosave-toggle.js';
import { ChangePasswordForm } from './components/change-password-form.js';
import { FormSection } from './components/form-section.js';
import { SignOutEverywhere } from './components/sign-out-everywhere.js';
import { ThemeSelect } from './components/theme-select.js';
import { useResolvedTheme } from './theme.js';
import { usePatchSettings } from './use-patch-settings.js';
import { useAutosaveEnabled, useSettingsStatus, useSettingsTheme } from './use-settings.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'the settings could not be loaded';
}

export function SettingsPage(): React.JSX.Element {
  const autosave = useAutosaveEnabled();
  const theme = useSettingsTheme();
  const resolvedTheme = useResolvedTheme();
  const status = useSettingsStatus();
  const patch = usePatchSettings();

  // Only a read that has nothing to show and cannot recover gets the page. A fresh account is not
  // that: PR-09's get-or-create means the first response is the default row, so this branch is a
  // `5xx` or a session that ended between the click and the request.
  if (status.isError) {
    return (
      <section data-testid="settings-page" className="flex flex-col gap-4" aria-busy={status.isLoading}>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p
          aria-live="assertive"
          data-testid="settings-error"
          className="max-w-prose rounded-md border border-red-700/30 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage(status.error)}
        </p>
        <button
          type="button"
          data-testid="settings-retry"
          onClick={status.retry}
          className="w-fit rounded-md border border-ink/20 px-4 py-1.5 text-sm"
        >
          Try again
        </button>
      </section>
    );
  }

  const patchError = patch.error === null ? undefined : errorMessage(patch.error);

  return (
    <section data-testid="settings-page" className="flex flex-col gap-8" aria-busy={status.isLoading}>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-muted">
          Preferences are saved as you change them and apply the moment the change lands.
        </p>
      </header>

      <FormSection
        title="Editing"
        description="These two change what the editor you have open is doing right now."
      >
        <div className="flex flex-col">
          <AutosaveToggle
            enabled={autosave}
            pending={patch.isPending}
            errorMessage={patchError}
            onToggle={(next) => {
              patch.mutate({ autosave: next });
            }}
          />
          <ThemeSelect
            theme={theme}
            resolved={resolvedTheme}
            pending={patch.isPending}
            errorMessage={patchError}
            onChange={(next) => {
              patch.mutate({ theme: next });
            }}
          />
        </div>
      </FormSection>

      <FormSection
        title="Account"
        description="Your password and your sessions. Changing your password signs out every other device but this one."
      >
        <div className="flex flex-col gap-8">
          <ChangePasswordForm />
          <SignOutEverywhere />
        </div>
      </FormSection>
    </section>
  );
}
