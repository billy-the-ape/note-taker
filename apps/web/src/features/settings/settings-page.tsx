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
 * already on screen, and a skeleton that flashes the same two defaults is a worse version of the
 * same wait.
 *
 * The error screen is gated on `isError && !hasData`, not `isError` alone, because the two failures
 * are different events. React Query v5 flags a failed **background refetch** while keeping the row,
 * and this screen refetches after every patch — so `isError` with data usually means "the values on
 * screen are the last good ones", not "nothing loaded". Replacing four working controls (and a
 * half-typed password) with a full-page error for that would be the worse bug; the note under the
 * header says the refresh failed instead.
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

  // Only a read that has nothing to show gets the page — hence `&& !hasData`, which is what keeps a
  // failed *background* refetch from replacing a working screen (see the file header). A fresh
  // account is not this branch either: PR-09's get-or-create means the first response is the default
  // row, so reaching here means a `5xx` or a session that ended before anything loaded. There is no
  // `aria-busy` here: `isLoading` is `isPending`, which cannot be true when `isError` is.
  if (status.isError && !status.hasData) {
    return (
      <section data-testid="settings-page" className="flex flex-col gap-4">
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
  // `isError` *with* a row: the values still shown are the last ones that loaded, and saying nothing
  // about that is how a switch quietly disagrees with the server. Loud enough to notice, quiet
  // enough not to bury the form: a note above the controls with its own retry.
  const refreshError = status.isError && status.hasData ? errorMessage(status.error) : undefined;

  return (
    <section data-testid="settings-page" className="flex flex-col gap-8" aria-busy={status.isLoading}>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-muted">
          Preferences are saved as you change them and apply the moment the change lands.
        </p>
      </header>

      {refreshError === undefined ? null : (
        <div
          aria-live="polite"
          data-testid="settings-refresh-error"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-600/30 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>{refreshError} — showing the settings that loaded last, which may be out of date.</span>
          <button
            type="button"
            data-testid="settings-refresh-retry"
            onClick={status.retry}
            className="font-medium underline"
          >
            Try again
          </button>
        </div>
      )}

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
